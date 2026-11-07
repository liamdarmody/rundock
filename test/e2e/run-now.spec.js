'use strict';
// Pressing Run on a routine's row in the real client: the control disables
// while the stub runtime runs, and the row comes back afterwards.
//
// THE STUB RUNTIME HAS TO BE THE ONE THE SERVER RESOLVES. The E2E launcher
// puts it first on the server's PATH; this spec still asks the server what it
// resolved and fails, rather than skipping, if the answer is not the stub,
// because a real agent would otherwise run with permissions skipped.
//
// THE SCHEDULER IS LIVE ON THE REAL CLOCK and a daily routine with no history
// is due the moment its time has passed today, so the routine is given a
// weekly slot three days out and the server's own next-run instant is
// asserted to be in the future before anything is pressed: the pressed run
// is the only run of this routine the spec can observe.
const { test, expect } = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require('ws');
const credentials = require('./credentials.js');

// What the stub answers `--version` with, as the server's probe reads it.
const STUB_VERSION = '2.1.318-stub';
const PORT = Number(process.env.E2E_PORT || 34517);
const ROUTINE = 'Pressed check';
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SCHEDULE = `every ${WEEKDAYS[(new Date().getDay() + 3) % 7]} at 07:00`;
const PROMPT = 'pressed e2e body';

// One WS session from the test's own process: learns the workspace the
// launcher seeded and writes the routine through the real save road.
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

test('pressing Run disables the control while the stub runtime runs, and the row comes back afterwards', async ({ page }) => {
  const { workspace, version, nextRun } = await overWs(async ({ send, waitFor }) => {
    send({ type: 'get_runtime_status' });
    const status = await waitFor(m => m.type === 'runtime_status');
    const version = status.claude && status.claude.version;
    if (version !== STUB_VERSION) return { workspace: null, version };
    send({ type: 'get_workspaces' });
    const set = await waitFor(m => m.type === 'workspaces' && m.current);
    fs.writeFileSync(path.join(set.current, 'stub-scenario.json'), JSON.stringify({
      rules: [{ match: { agent: 'wren', promptIncludes: PROMPT }, delayMs: 3000, turn: [{ text: 'pressed run ran' }] }],
    }));
    send({ type: 'save_routine', agentId: 'wren', routine: { name: ROUTINE, schedule: SCHEDULE, prompt: PROMPT, runOn: 'local' } });
    await waitFor(m => m.type === 'routine_saved' && m.name === ROUTINE);
    const roster = await waitFor(m => m.type === 'agents' && m.agents.some(a => (a.routines || []).some(r => r.name === ROUTINE)));
    const row = roster.agents.find(a => a.id === 'wren').routines.find(r => r.name === ROUTINE);
    return { workspace: set.current, version, nextRun: row.nextRun };
  });
  expect(version, 'the server must resolve the stub runtime, or nothing may be pressed').toBe(STUB_VERSION);
  expect(new Date(nextRun).getTime(), 'the server must not be able to bring this routine due during the spec').toBeGreaterThan(Date.now() + 60 * 60 * 1000);
  expect(fs.existsSync(path.join(workspace, '.claude', 'agents', 'wren.md'))).toBe(true);
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
    .filter(name => name.endsWith('.json'))
    .map(name => JSON.parse(fs.readFileSync(path.join(workspace, '.rundock', 'runs', name), 'utf-8')));
  expect(records.filter(r => r.routine === ROUTINE).map(r => r.trigger)).toEqual(['manual']);
});

// ===== A CHANGED FILE OPENS FROM THE RUN SCREEN =====
//
// The run writes two files through the stub's Write tool: a note the file
// tree lists, and a file in a dot folder it does not. Both are named by
// absolute paths built from the workspace the server reports, which is the
// spelling the run screen holds as the root. The stub would otherwise name
// them from its own working directory, which on a machine whose temporary
// folder sits behind a symlink is another spelling of the same folder, and
// every name would then stay plain: the safe failure, and not this test.
const OPENED = 'Opened from run';
const OPENED_PROMPT = 'opened e2e body';

// A computed colour, in either form a browser reports, as 0..255 channels:
// rgb(r, g, b) in whole channels, or color(srgb r g b) in fractions of one.
function channels(css) {
  const scale = css.startsWith('color(srgb ') ? 255 : css.startsWith('rgb') ? 1 : null;
  if (scale === null) throw new Error(`cannot read the colour ${css}`);
  return css.slice(css.indexOf('(') + 1, css.indexOf(')')).replace('srgb', '').replace(/,/g, ' ')
    .trim().split(/\s+/).slice(0, 3).map(n => Number(n) * scale);
}
const hexChannels = (hex) => { const n = parseInt(hex.trim().slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const near = (a, b) => a.every((c, i) => Math.abs(c - b[i]) <= 1);

test('a changed file the tree lists opens from the run screen, by click and by Enter, in the link colour', async ({ page }) => {
  const { workspace, version } = await overWs(async ({ send, waitFor }) => {
    send({ type: 'get_runtime_status' });
    const status = await waitFor(m => m.type === 'runtime_status');
    const version = status.claude && status.claude.version;
    if (version !== STUB_VERSION) return { workspace: null, version };
    send({ type: 'get_workspaces' });
    const set = await waitFor(m => m.type === 'workspaces' && m.current);
    const scenario = path.join(set.current, 'stub-scenario.json');
    const prior = fs.existsSync(scenario) ? JSON.parse(fs.readFileSync(scenario, 'utf-8')).rules || [] : [];
    fs.writeFileSync(scenario, JSON.stringify({ rules: [...prior, {
      match: { agent: 'wren', promptIncludes: OPENED_PROMPT },
      delayMs: 1500,
      writes: [
        { tool: 'Write', file: path.join(set.current, 'Run output', 'opened-from-run.md'), content: '# Opened from the run\n' },
        { tool: 'Write', file: path.join(set.current, '.run-scratch', 'hidden.md'), content: 'hidden\n' },
      ],
      turn: [{ text: 'opened run ran' }],
    }] }));
    send({ type: 'save_routine', agentId: 'wren', routine: { name: OPENED, schedule: SCHEDULE, prompt: OPENED_PROMPT, runOn: 'local' } });
    await waitFor(m => m.type === 'routine_saved' && m.name === OPENED);
    await waitFor(m => m.type === 'agents' && m.agents.some(a => (a.routines || []).some(r => r.name === OPENED)));
    return { workspace: set.current, version };
  });
  expect(version, 'the server must resolve the stub runtime, or nothing may be pressed').toBe(STUB_VERSION);
  await page.goto('/');
  const row = page.locator('.routine-row', { hasText: OPENED });
  const run = row.locator('[data-routines-action="run"]');
  const link = page.locator('#run-detail-content button[data-run-detail="file-name"]', { hasText: 'opened-from-run.md' });
  // A run pressed by hand leaves the routine's last-run slot alone, so its
  // record is reached while it is going, through the row's View run. The
  // screen then follows the run to its end, and the name links once the
  // record and the tree that lists the new file have both arrived.
  const runAndOpen = async () => {
    await page.click('.nav-item[data-nav="routines"]');
    await expect(run).toBeEnabled({ timeout: 15000 });
    await run.click();
    await row.locator('[data-routines-action="view-run"]').click();
    await expect(link).toBeVisible({ timeout: 20000 });
  };
  await runAndOpen();
  expect(fs.existsSync(path.join(workspace, 'Run output', 'opened-from-run.md')), 'the run wrote the file').toBe(true);
  await expect(link).toHaveAttribute('title', 'Open in Files');
  await expect(page.locator('#run-detail-content span[data-run-detail="file-name"]', { hasText: 'hidden.md' })).toBeVisible();
  const plainNote = page.locator('[data-run-detail="plain-names"]');
  await expect(plainNote).toHaveText("Names in plain text can't be opened here: hidden files and folders, code and config files, and files that have since been moved or deleted.");

  // The link colour and the plain-name sentence, in the light theme, as the
  // browser computes them from the light tokens.
  await page.evaluate(() => { if (!document.body.classList.contains('light')) toggleTheme(); });
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('light'))).toBe(true);
  const colours = await page.evaluate(() => {
    const body = getComputedStyle(document.body);
    return {
      accentText: body.getPropertyValue('--accent-text'), text1: body.getPropertyValue('--text-1'),
      text2Strong: body.getPropertyValue('--text-2-strong'),
      link: getComputedStyle(document.querySelector('#run-detail-content button[data-run-detail="file-name"]')).color,
      plain: getComputedStyle(document.querySelector('[data-run-detail="plain-names"]')).color,
    };
  });
  expect(colours.accentText.trim().toUpperCase(), 'sanity: the light --accent-text').toBe('#BF401B');
  const mixed = hexChannels(colours.accentText).map((c, i) => c * 0.85 + hexChannels(colours.text1)[i] * 0.15);
  expect(near(channels(colours.link), mixed), `the link draws in ${colours.link}, not the light mix ${mixed.map(Math.round)}`).toBe(true);
  expect(near(channels(colours.plain), hexChannels(colours.text2Strong)), `the sentence draws in ${colours.plain}`).toBe(true);

  // A click opens the file in Files, its tree row highlighted.
  await link.click();
  await expect(page.locator('#view-editor')).toBeVisible();
  await expect(page.locator('#editor-filename')).toContainText('opened-from-run');
  await expect(page.locator('#file-tree .file-item.active')).toHaveAttribute('data-path', 'Run output/opened-from-run.md');

  // Enter on the focused name opens it too, from the next run's record.
  await page.locator('#file-tree .file-item.active').evaluate((el) => el.classList.remove('active'));
  await runAndOpen();
  await link.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#view-editor')).toBeVisible();
  await expect(page.locator('#file-tree .file-item.active')).toHaveAttribute('data-path', 'Run output/opened-from-run.md');
});
