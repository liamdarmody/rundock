'use strict';
// The routine screens in the real client: the run screen's captions in the
// light theme, and the routines panel's scope rows from the keyboard.
//
// Built the way run-now.spec.js is. Routines are written through the real
// save road over the spec's own socket, and a run is pressed against the stub
// runtime, which this spec asks the server about first and refuses to press
// anything without. Every routine is given a weekly slot three days out, so
// the live scheduler cannot fire one during the spec, and every routine and
// scenario the spec writes is taken back afterwards: the server and its
// workspace are shared with the specs that run after this one.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const credentials = require('./credentials.js');

// What the stub answers `--version` with, as the server's probe reads it.
const STUB_VERSION = '2.1.318-stub';
const PORT = Number(process.env.E2E_PORT || 34517);
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SCHEDULE = `every ${WEEKDAYS[(new Date().getDay() + 3) % 7]} at 07:00`;

// One WS session from the test's own process.
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

// Writes each routine through the real save road, and the stub's scenario
// when one is given, keeping what the scenario file held before.
async function seed(routines, scenario) {
  return overWs(async ({ send, waitFor }) => {
    send({ type: 'get_runtime_status' });
    const status = await waitFor(m => m.type === 'runtime_status');
    const version = status.claude && status.claude.version;
    if (version !== STUB_VERSION) return { version };
    send({ type: 'get_workspaces' });
    const set = await waitFor(m => m.type === 'workspaces' && m.current);
    const scenarioFile = path.join(set.current, 'stub-scenario.json');
    const before = fs.existsSync(scenarioFile) ? fs.readFileSync(scenarioFile, 'utf-8') : null;
    if (scenario) fs.writeFileSync(scenarioFile, JSON.stringify(scenario));
    for (const { agentId, name, prompt } of routines) {
      send({ type: 'save_routine', agentId, routine: { name, schedule: SCHEDULE, prompt, runOn: 'local' } });
      await waitFor(m => m.type === 'routine_saved' && m.name === name);
    }
    return { version, scenarioFile, before };
  });
}

async function unseed(routines, seeded) {
  if (seeded.scenarioFile) {
    if (seeded.before === null) fs.rmSync(seeded.scenarioFile, { force: true });
    else fs.writeFileSync(seeded.scenarioFile, seeded.before);
  }
  await overWs(async ({ send, waitFor }) => {
    for (const { agentId, name } of routines) {
      send({ type: 'delete_routine', agentId, name, occurrence: 0 });
      await waitFor(m => m.type === 'routine_deleted' && m.name === name);
    }
  });
}

// A token as the browser resolves it, inside <body> where the light theme's
// overrides apply: a fresh probe painted with the token, with no transition,
// so the value read is the token's own rather than one partway to it.
function tokenColour(page, prop, name) {
  return page.evaluate(([p, token]) => {
    const probe = document.createElement('span');
    probe.style.transition = 'none';
    probe.style.setProperty(p, `var(${token})`);
    document.body.appendChild(probe);
    const got = getComputedStyle(probe).getPropertyValue(p);
    probe.remove();
    return got;
  }, [prop, name]);
}

// Switch to the light theme and wait for the color transition to settle: the
// universal selector carries a 0.2s color transition, so a color read sooner
// is the interpolated one. Same settle as theme.spec.js: the page background
// has arrived at the light base.
async function goLight(page) {
  await page.evaluate(() => { if (!document.body.classList.contains('light')) toggleTheme(); });
  const base = await tokenColour(page, 'background-color', '--base');
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.body).backgroundColor),
    { message: 'the light theme must settle' }).toBe(base);
}

test('in the light theme the run screen\'s context line, Took line and guidance draw the strong secondary text token', async ({ page }) => {
  const NAME = 'Caption check';
  const PROMPT = 'caption e2e body';
  const routines = [{ agentId: 'wren', name: NAME, prompt: PROMPT }];
  const seeded = await seed(routines, {
    // Long enough to open the run while it is going: a run pressed by hand
    // offers its record from the row only while it is in flight.
    rules: [{ match: { agent: 'wren', promptIncludes: PROMPT }, crash: 1, delayMs: 3000, stderr: 'the stub stopped this run on purpose' }],
  });
  expect(seeded.version, 'the server must resolve the stub runtime, or nothing may be pressed').toBe(STUB_VERSION);
  try {
    await page.goto('/');
    await goLight(page);
    await page.click('.nav-item[data-nav="routines"]');
    const row = page.locator('.routine-row', { hasText: NAME });
    await expect(row).toBeVisible();
    await row.locator('[data-routines-action="run"]').click();
    await expect(row.locator('.run-status.live')).toBeVisible();
    await row.locator('[data-routines-action="view-run"]').click();

    // The screen re-reads the record when the run ends, and a failed run
    // carries all three captions: who ran it, how long it took, and why.
    const screen = page.locator('#view-run-detail');
    await expect(screen.locator('[data-run-detail="chip"]')).toHaveClass(/\bbad\b/, { timeout: 15000 });
    for (const sel of ['.rd-context', '.rd-took', '[data-run-detail="guidance"]']) {
      await expect(screen.locator(sel)).toBeVisible();
    }
    await expect(screen.locator('.rd-context')).toHaveText('Wren');
    const want = await tokenColour(page, 'color', '--text-2-strong');
    expect(want, 'sanity: the light strong secondary text token reads as a color').toBe('rgb(105, 100, 93)');
    await expect.poll(() => screen.evaluate((el) => {
      const colour = (sel) => getComputedStyle(el.querySelector(sel)).color;
      return { context: colour('.rd-context'), took: colour('.rd-took'), guidance: colour('[data-run-detail="guidance"]') };
    })).toEqual({ context: want, took: want, guidance: want });
  } finally {
    await unseed(routines, seeded);
  }
});
