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
function tokenColor(page, prop, name) {
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
  const base = await tokenColor(page, 'background-color', '--base');
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
    const want = await tokenColor(page, 'color', '--text-2-strong');
    expect(want, 'sanity: the light strong secondary text token reads as a color').toBe('rgb(105, 100, 93)');
    await expect.poll(() => screen.evaluate((el) => {
      const color = (sel) => getComputedStyle(el.querySelector(sel)).color;
      return { context: color('.rd-context'), took: color('.rd-took'), guidance: color('[data-run-detail="guidance"]') };
    })).toEqual({ context: want, took: want, guidance: want });
  } finally {
    await unseed(routines, seeded);
  }
});

// ===== THE SCOPE ROWS, FROM THE KEYBOARD =====
//
// Two owners, so the panel draws a row for each beside All. Wren's routine and
// the orchestrator's are told apart by name, and every check on the list is
// about which of the two is listed, so a routine another spec left behind
// changes nothing here.
const WREN = { agentId: 'wren', name: 'Keyboard wren', prompt: 'keyboard e2e wren' };
const LEAD = { agentId: 'default', name: 'Keyboard lead', prompt: 'keyboard e2e lead' };

async function openRoutines(page) {
  await page.goto('/');
  await page.click('.nav-item[data-nav="routines"]');
  await expect(page.locator('#sidebar-routines .scope-item[data-scope="wren"]')).toBeVisible();
  await expect(page.locator('#sidebar-routines .scope-item[data-scope="default"]')).toBeVisible();
}

const focusedScope = (page) => page.evaluate(() => {
  const el = document.activeElement;
  return el && el.closest('#sidebar-routines') ? el.getAttribute('data-scope') : null;
});
const activeScope = (page) => page.locator('#sidebar-routines .scope-item.active').getAttribute('data-scope');
// Whether the list holds a routine, by the name its sentence ends on.
const lists = async (page, name) => (await page.locator('#view-routines .routine-row .rr-sentence')
  .allTextContents()).some((t) => t.includes(name));

// Tab (or Shift+Tab) until the focus is on the named scope row, from wherever
// it is, and fail by name if the row is never reached.
async function tabTo(page, scope, key = 'Tab') {
  for (let i = 0; i < 8; i++) {
    if (await focusedScope(page) === scope) return;
    await page.keyboard.press(key);
  }
  expect(await focusedScope(page), `${key} never reached the ${scope} scope row`).toBe(scope);
}

test.describe('the scope rows from the keyboard', () => {
  let seeded;
  test.beforeAll(async () => {
    seeded = await seed([WREN, LEAD]);
    expect(seeded.version, 'the server must resolve the stub runtime').toBe(STUB_VERSION);
  });
  test.afterAll(async () => { if (seeded) await unseed([WREN, LEAD], seeded); });

  test('Enter selects a scope, Space selects All again, and the full list comes back', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openRoutines(page);
    await page.locator('#routines-add-btn').focus();
    await page.keyboard.press('Tab');
    expect(await focusedScope(page), 'Tab from the header control lands on All').toBe('all');

    // The ring a keyboard focus draws: 2px of the control accent, inside the row.
    const ring = await page.evaluate(() => {
      const cs = getComputedStyle(document.activeElement);
      const probe = document.createElement('span');
      probe.style.transition = 'none';
      probe.style.color = 'var(--accent-control)';
      document.body.appendChild(probe);
      const want = getComputedStyle(probe).color;
      probe.remove();
      return { style: cs.outlineStyle, width: cs.outlineWidth, offset: cs.outlineOffset, color: cs.outlineColor, want };
    });
    expect(ring).toEqual({ style: 'solid', width: '2px', offset: '-2px', color: ring.want, want: ring.want });

    await tabTo(page, 'wren');
    await page.keyboard.press('Enter');
    await expect.poll(() => activeScope(page), { message: 'Enter on the Wren row selects Wren' }).toBe('wren');
    expect(await lists(page, WREN.name), 'Wren\'s routine is listed').toBe(true);
    expect(await lists(page, LEAD.name), 'the lead\'s routine is not listed').toBe(false);
    expect(await focusedScope(page), 'the focus stays on the row that was pressed').toBe('wren');

    await tabTo(page, 'all', 'Shift+Tab');
    await page.keyboard.press('Space');
    await expect.poll(() => activeScope(page), { message: 'Space on All selects All' }).toBe('all');
    expect([await lists(page, WREN.name), await lists(page, LEAD.name)], 'All lists both routines again').toEqual([true, true]);

    await tabTo(page, 'default');
    await page.keyboard.press('Space');
    await expect.poll(() => activeScope(page), { message: 'Space on an owner selects that owner' }).toBe('default');
    expect(await lists(page, LEAD.name), 'the lead\'s routine is listed').toBe(true);
    expect(await lists(page, WREN.name), 'Wren\'s routine is not listed').toBe(false);
    expect(errors).toEqual([]);
  });

  test('Enter twice on one scope selects it once, and only ever draws that scope', async ({ page }) => {
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openRoutines(page);
    await page.evaluate(() => {
      const real = window.setRoutinesScope;
      window.scopesDrawn = [];
      window.setRoutinesScope = (id) => { window.scopesDrawn.push(id); return real(id); };
    });
    await page.locator('#sidebar-routines .scope-item[data-scope="wren"]').focus();
    await page.keyboard.press('Enter');
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => window.scopesDrawn), { message: 'both presses reach the Wren row' })
      .toEqual(['wren', 'wren']);
    expect(await activeScope(page)).toBe('wren');
    expect(await lists(page, WREN.name), 'Wren\'s routine is listed').toBe(true);
    expect(await lists(page, LEAD.name), 'the lead\'s routine is not listed').toBe(false);
    expect(errors).toEqual([]);
  });

  test('Tab from a selected scope moves into that scope\'s routines', async ({ page }) => {
    await openRoutines(page);
    await page.locator('#sidebar-routines .scope-item[data-scope="wren"]').focus();
    await page.keyboard.press('Enter');
    await expect.poll(() => activeScope(page)).toBe('wren');
    let row = null;
    for (let i = 0; i < 12 && row === null; i++) {
      await page.keyboard.press('Tab');
      row = await page.evaluate(() => {
        const r = document.activeElement && document.activeElement.closest('#view-routines .routine-row');
        return r ? r.querySelector('.rr-sentence').textContent : null;
      });
    }
    expect(row, 'Tab never reached a routine row').not.toBeNull();
    expect(row.includes(LEAD.name), 'Tab reached a routine of a scope that is not selected').toBe(false);
    expect(await lists(page, LEAD.name)).toBe(false);
  });

  test('a scope row lays out as it did: full width, the panel\'s type, and its fills', async ({ page }) => {
    await openRoutines(page);
    const got = await page.evaluate(() => {
      const list = document.querySelector('#sidebar-routines .routines-scope-list');
      const row = list.querySelector('.scope-item[data-scope="wren"]');
      const lcs = getComputedStyle(list);
      const inner = list.clientWidth - parseFloat(lcs.paddingLeft) - parseFloat(lcs.paddingRight);
      const cs = getComputedStyle(row);
      return {
        fullWidth: Math.abs(row.getBoundingClientRect().width - inner) < 0.5,
        align: cs.textAlign,
        size: cs.fontSize === lcs.fontSize,
        lineHeight: cs.lineHeight === lcs.lineHeight,
        rest: cs.backgroundColor,
        edge: cs.borderTopStyle,
      };
    });
    expect(got).toEqual({ fullWidth: true, align: 'start', size: true, lineHeight: true, rest: 'rgba(0, 0, 0, 0)', edge: 'none' });

    // The selected fill on All, which the page opens on, and the hover fill.
    const fill = (selector) => page.locator(selector).evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(await fill('#sidebar-routines .scope-item.active')).toBe(await tokenColor(page, 'background-color', '--accent-glow'));
    await page.locator('#sidebar-routines .scope-item[data-scope="wren"]').hover();
    const hover = await tokenColor(page, 'background-color', '--elevated');
    await expect.poll(() => fill('#sidebar-routines .scope-item[data-scope="wren"]'), { message: 'the hover fill' }).toBe(hover);
  });
});
