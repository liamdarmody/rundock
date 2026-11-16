'use strict';
// E2E: the nav rail's keyboard shortcuts.
//
// Cmd or Ctrl with a digit opens the rail's main views by their place in it,
// and with the comma opens Settings. Which modifier is the client's own, so
// every test here first presents the page as a given client, by its
// navigator, before any script runs: a Mac browser, a Windows or Linux one,
// or one whose platform cannot be read. The server is whatever runs the
// suite, which in CI is Linux, so the Mac client here is a Mac browser
// against a Linux server.
//
// A spy on switchNav, the function a rail click calls, records every
// arrival, so a test can tell that a key took the click's path and not
// another. A window listener records whether anything prevented each key,
// which is how a test tells that a key the shortcuts do not own reached the
// page untouched.
const fs = require('node:fs');
const path = require('node:path');
const { test, expect } = require('@playwright/test');
const WebSocket = require('ws');
const credentials = require('./credentials.js');

const PORT = Number(process.env.E2E_PORT || 34517);

const CLIENTS = {
  mac: { platform: 'MacIntel', hints: 'macOS' },
  windows: { platform: 'Win32', hints: 'Windows' },
  linux: { platform: 'Linux x86_64', hints: 'Linux' },
  unreadable: { platform: '', hints: null },
};
const MOD = { mac: 'Meta', windows: 'Control', linux: 'Control', unreadable: 'Control' };
const OTHER = { Meta: 'Control', Control: 'Meta' };
const SIGN = { Meta: '⌘', Control: 'Ctrl ' };
const RAIL = ['conversations', 'team', 'skills', 'routines', 'files', 'pins', 'map'];

const NOTE = 'nav-shortcuts-note.md';
const NOTE_BODY = '# Shortcut note\n\nA paragraph to edit.\n';
let workspace = null;

test.afterAll(() => {
  if (workspace) fs.rmSync(path.join(workspace, NOTE), { force: true });
});

async function instrument(page) {
  await expect(page.locator('.nav-rail')).toBeVisible();
  await page.evaluate(() => {
    window.navArrivals = [];
    window.mapArrivals = 0;
    window.keysSeen = [];
    const realSwitch = window.switchNav;
    window.switchNav = function (nav) { window.navArrivals.push(nav); return realSwitch.apply(this, arguments); };
    const realMap = window.showMapView;
    window.showMapView = function () { window.mapArrivals++; return realMap.apply(this, arguments); };
    window.addEventListener('keydown', (e) => window.keysSeen.push({ key: e.key, prevented: e.defaultPrevented }));
  });
}

async function boot(page, client) {
  await page.addInitScript((c) => {
    Object.defineProperty(Navigator.prototype, 'platform', { configurable: true, get: () => c.platform });
    Object.defineProperty(Navigator.prototype, 'userAgentData', {
      configurable: true,
      get: () => (c.hints === null ? undefined : { platform: c.hints, brands: [], mobile: false }),
    });
  }, CLIENTS[client]);
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await instrument(page);
}

// A fresh note open in Files, written before the page loads so the tree
// lists it.
async function bootWithNote(page, client) {
  await boot(page, client);
  workspace = await page.evaluate(() => currentWorkspacePath);
  fs.writeFileSync(path.join(workspace, NOTE), NOTE_BODY);
  await page.reload();
  await expect(page.locator('.convo-item').first()).toBeVisible();
  await page.locator('.nav-item[data-nav="files"]').click();
  await page.locator('.file-item', { hasText: NOTE }).first().click();
  await expect(page.locator('.ProseMirror p')).toHaveText('A paragraph to edit.');
  await instrument(page);
}

const readNote = () => fs.readFileSync(path.join(workspace, NOTE), 'utf8');
const paragraph = (page) => page.locator('.ProseMirror p').first();

async function typeAtEndOfNote(page, text) {
  await page.evaluate(() => {
    const pm = document.querySelector('.ProseMirror');
    pm.focus();
    const p = pm.querySelector('p');
    const range = document.createRange();
    range.selectNodeContents(p);
    range.collapse(false);
    const sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
  });
  await page.keyboard.type(text);
}

async function expectSection(page, nav) {
  await expect(page.locator(`.nav-item.active[data-nav="${nav}"]`)).toBeVisible();
  // Some panels are empty until drawn, so the panel's own hidden class is
  // what says which one is up.
  await expect(page.locator(`#sidebar-${nav}`)).not.toHaveClass(/\bhidden\b/);
}

const arrivals = (page) => page.evaluate(() => window.navArrivals.slice());
const lastKey = (page) => page.evaluate(() => window.keysSeen[window.keysSeen.length - 1]);

// A key the shortcuts must leave alone: nothing switches and nothing
// prevented it.
async function expectUntouched(page, combo, nav) {
  const before = await arrivals(page);
  await page.keyboard.press(combo);
  expect((await lastKey(page)).prevented, `${combo} was prevented`).toBe(false);
  expect(await arrivals(page), `${combo} switched the view`).toEqual(before);
  await expectSection(page, nav);
}

// ── Opening the views ───────────────────────────────────────────────────────

for (const client of ['mac', 'linux']) {
  const mod = MOD[client];
  test(`${mod} with each digit opens the rail's main views in order, the way a click does, on a ${client} client`, async ({ page }) => {
    await boot(page, client);
    const order = await page.$$eval('.nav-main button.nav-item[data-nav]', (els) => els.map((el) => el.getAttribute('data-nav')));
    expect(order).toEqual(RAIL);
    const expected = [];
    for (const n of [2, 3, 4, 5, 6, 7, 1]) {
      await page.keyboard.press(`${mod}+${n}`);
      await expectSection(page, order[n - 1]);
      expected.push(order[n - 1]);
      expect(await arrivals(page)).toEqual(expected);
      expect((await lastKey(page)).prevented).toBe(true);
    }
    for (const n of [8, 9]) await expectUntouched(page, `${mod}+${n}`, 'conversations');
  });

  test(`${mod} with a digit opens a view from inside the composer, the editor and a text field, inserting nothing, on a ${client} client`, async ({ page }) => {
    await bootWithNote(page, client);
    // The editor.
    await typeAtEndOfNote(page, ' typed');
    await page.keyboard.press(`${mod}+1`);
    await expectSection(page, 'conversations');
    // The composer.
    const composer = page.locator('#msg-input');
    await composer.click();
    await page.keyboard.type('a draft');
    await page.keyboard.press(`${mod}+2`);
    await expectSection(page, 'team');
    // A text field: the conversation's title.
    await page.keyboard.press(`${mod}+1`);
    await expectSection(page, 'conversations');
    await expect(composer).toHaveValue('a draft');
    await composer.fill('');
    const title = page.locator('#chat-title-input');
    const before = await title.inputValue();
    await title.focus();
    await page.keyboard.press(`${mod}+3`);
    await expectSection(page, 'skills');
    await expect(title).toHaveValue(before);
    // Back in the editor, the note holds only what was typed.
    await page.keyboard.press(`${mod}+5`);
    await expectSection(page, 'files');
    await expect(paragraph(page)).toHaveText('A paragraph to edit. typed');
    expect(await arrivals(page)).toEqual(['conversations', 'team', 'conversations', 'skills', 'files']);
  });
}

for (const client of ['mac', 'windows']) {
  const mod = MOD[client];
  test(`${mod} with the comma opens Settings on a ${client} client`, async ({ page }) => {
    await boot(page, client);
    await page.keyboard.press(`${mod}+Comma`);
    await expectSection(page, 'settings');
    await expect(page.locator('#view-settings')).toBeVisible();
    expect(await arrivals(page)).toEqual(['settings']);
  });
}

// ── Order, modifier and hints ───────────────────────────────────────────────

test('reordering the rail moves the shortcuts and their hints with it, with nothing else called', async ({ page }) => {
  await boot(page, 'mac');
  await page.evaluate(() => {
    const main = document.querySelector('.nav-main');
    main.insertBefore(main.querySelector('[data-nav="map"]'), main.firstElementChild);
  });
  const reordered = ['map', ...RAIL.filter((nav) => nav !== 'map')];
  const hints = () => page.$$eval('.nav-main button.nav-item[data-nav]', (els) => els.map((el) => ({
    nav: el.getAttribute('data-nav'),
    tooltip: el.getAttribute('data-tooltip'),
    keys: el.getAttribute('aria-keyshortcuts'),
  })));
  const label = (nav) => nav.charAt(0).toUpperCase() + nav.slice(1);
  await expect.poll(hints).toEqual(reordered.map((nav, i) => ({
    nav, tooltip: `${label(nav)} (⌘${i + 1})`, keys: `Meta+${i + 1}`,
  })));
  await page.keyboard.press('Meta+1');
  await expectSection(page, 'map');
  await page.keyboard.press('Meta+2');
  await expectSection(page, 'conversations');
  await page.keyboard.press('Meta+7');
  await expectSection(page, 'pins');
  expect(await arrivals(page)).toEqual(['map', 'conversations', 'pins']);
});

test('a Mac client answers Cmd and ignores Ctrl, whatever the server runs on', async ({ page }) => {
  await boot(page, 'mac');
  await expectUntouched(page, 'Control+2', 'conversations');
  await expectUntouched(page, 'Control+Comma', 'conversations');
  await page.keyboard.press('Meta+2');
  await expectSection(page, 'team');
  expect(await arrivals(page)).toEqual(['team']);
});

for (const client of ['windows', 'linux']) {
  test(`a ${client} client answers Ctrl and ignores the Windows key`, async ({ page }) => {
    await boot(page, client);
    await expectUntouched(page, 'Meta+2', 'conversations');
    await expectUntouched(page, 'Meta+Comma', 'conversations');
    await page.keyboard.press('Control+2');
    await expectSection(page, 'team');
    expect(await arrivals(page)).toEqual(['team']);
  });
}

for (const client of ['mac', 'windows']) {
  const mod = MOD[client];
  test(`each tooltip names its shortcut in the search hint's form, and the key it names opens it, on a ${client} client`, async ({ page }) => {
    await boot(page, client);
    const searchHint = await page.locator('#tb-search-kbd').textContent();
    expect(searchHint).toBe(`${SIGN[mod]}K`);
    const items = await page.$$eval('.nav-rail button.nav-item[data-nav]', (els) => els.map((el) => ({
      nav: el.getAttribute('data-nav'),
      tooltip: el.getAttribute('data-tooltip'),
      shown: getComputedStyle(el, '::after').content,
      keys: el.getAttribute('aria-keyshortcuts'),
    })));
    expect(items.map((i) => i.nav)).toEqual([...RAIL, 'settings']);
    const theme = page.locator('#theme-toggle');
    await expect(theme).not.toHaveAttribute('aria-keyshortcuts', /./);
    const expected = [];
    for (const [i, item] of items.entries()) {
      const key = item.nav === 'settings' ? ',' : String(i + 1);
      expect(item.tooltip).toMatch(new RegExp(`^\\S.* \\(${SIGN[mod]}${key}\\)$`));
      expect(item.shown).toBe(JSON.stringify(item.tooltip));
      expect(item.keys).toBe(`${mod}+${key}`);
      // The key the hint names is the key that opens the item.
      const [held, pressed] = item.keys.split('+');
      await page.keyboard.press(`${held}+${pressed === ',' ? 'Comma' : pressed}`);
      await expectSection(page, item.nav);
      expected.push(item.nav);
    }
    expect(await arrivals(page)).toEqual(expected);
  });
}

// ── Keys the shortcuts leave alone ──────────────────────────────────────────

for (const client of ['mac', 'windows']) {
  const mod = MOD[client];
  test(`Shift, Alt or the other platform's modifier with a digit or the comma does nothing on a ${client} client`, async ({ page }) => {
    await bootWithNote(page, client);
    await page.evaluate(() => document.activeElement.blur());
    for (const combo of [
      `${mod}+Shift+2`, `${mod}+Alt+2`, `${OTHER[mod]}+2`, `Control+Meta+2`,
      `${mod}+Shift+Comma`, `${mod}+Alt+Comma`, `${OTHER[mod]}+Comma`,
    ]) {
      await expectUntouched(page, combo, 'files');
    }
    // Inside the note, the editor's own Alt and Shift shortcuts with a digit
    // still reach it: a heading, back to a paragraph, then a bullet list.
    await typeAtEndOfNote(page, '');
    await page.keyboard.press(`${mod}+Alt+2`);
    await expect(page.locator('.ProseMirror h2')).toHaveText('A paragraph to edit.');
    await page.keyboard.press(`${mod}+Alt+0`);
    await expect(paragraph(page)).toHaveText('A paragraph to edit.');
    await page.keyboard.press(`${mod}+Shift+8`);
    await expect(page.locator('.ProseMirror ul')).toHaveCount(1);
    await expectSection(page, 'files');
    expect(await arrivals(page)).toEqual([]);
  });
}

test('while the search palette or a modal dialog is open the shortcuts do nothing', async ({ page }) => {
  await boot(page, 'mac');
  await page.keyboard.press('Meta+k');
  await expect(page.locator('#palette-input')).toBeFocused();
  await expectUntouched(page, 'Meta+2', 'conversations');
  await expectUntouched(page, 'Meta+Comma', 'conversations');
  await expect(page.locator('#palette-overlay')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('#palette-overlay')).toBeHidden();
  await page.evaluate(() => {
    const dialog = document.createElement('div');
    dialog.id = 'test-modal';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.textContent = 'A modal dialog';
    document.body.append(dialog);
  });
  await expectUntouched(page, 'Meta+2', 'conversations');
  await page.evaluate(() => document.getElementById('test-modal').remove());
  await page.keyboard.press('Meta+2');
  await expectSection(page, 'team');
  expect(await arrivals(page)).toEqual(['team']);
});

for (const client of ['mac', 'windows']) {
  const mod = MOD[client];
  test(`copy, paste, select-all, undo, redo and zoom pass through, and find, save and the palette still act, on a ${client} client`, async ({ page }) => {
    await bootWithNote(page, client);
    await page.locator('.nav-item[data-nav="conversations"]').click();
    await expectSection(page, 'conversations');
    const composer = page.locator('#msg-input');
    await composer.click();
    await page.keyboard.type('some words');
    const clicks = await arrivals(page);
    for (const key of ['a', 'c', 'v', 'z', 'Shift+z', 'y', 'Equal', 'Minus', 'Digit0']) {
      await expectUntouched(page, `${mod}+${key}`, 'conversations');
    }
    await composer.fill('');
    // Find.
    await page.keyboard.press(`${mod}+f`);
    await expect(page.locator('#find-bar')).toBeVisible();
    await page.keyboard.press('Escape');
    // The palette.
    await page.keyboard.press(`${mod}+k`);
    await expect(page.locator('#palette-input')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(page.locator('#palette-overlay')).toBeHidden();
    // Save, in the note.
    await page.locator('.nav-item[data-nav="files"]').click();
    await typeAtEndOfNote(page, ' saved now');
    await page.keyboard.press(`${mod}+s`);
    expect((await lastKey(page)).prevented, 'the save shortcut ran').toBe(true);
    await expect.poll(readNote).toContain('saved now');
    expect(await arrivals(page)).toEqual([...clicks, 'files']);
  });
}

// ── The five sequences ──────────────────────────────────────────────────────

test('the inverse action: Cmd+3 then Cmd+1 returns to the open conversation, its unsent text as a click leaves it', async ({ page }) => {
  await boot(page, 'mac');
  await page.locator('.convo-item', { hasText: 'July content calendar' }).click();
  const title = page.locator('#chat-title-input');
  const composer = page.locator('#msg-input');
  await expect(title).toHaveValue('July content calendar');
  const state = async () => ({ title: await title.inputValue(), draft: await composer.inputValue() });
  // By the rail, as the control.
  await composer.fill('Unsent words');
  await page.locator('.nav-item[data-nav="skills"]').click();
  await expectSection(page, 'skills');
  await page.locator('.nav-item[data-nav="conversations"]').click();
  await expectSection(page, 'conversations');
  const byClick = await state();
  expect(byClick.title).toBe('July content calendar');
  // By the keys, from inside the composer.
  await composer.fill('Unsent words');
  await composer.focus();
  await page.keyboard.press('Meta+3');
  await expectSection(page, 'skills');
  await page.keyboard.press('Meta+1');
  await expectSection(page, 'conversations');
  expect(await state()).toEqual(byClick);
  expect(await arrivals(page)).toEqual(['skills', 'conversations', 'skills', 'conversations']);
  await composer.fill('');
});

test('the undo: undo after a shortcut acts on the text field as before, and the shortcut adds nothing to its history', async ({ page }) => {
  await bootWithNote(page, 'mac');
  // Each half measures undo first without the shortcut, then redoes it and
  // presses the shortcut before undoing again: the same undo must give the
  // same text. The editor's undo is its own. Files is already open, so the
  // shortcut arrives where the note is and the note keeps its place.
  await typeAtEndOfNote(page, ' and back');
  const typed = await paragraph(page).textContent();
  await page.keyboard.press('Meta+z');
  const undone = await paragraph(page).textContent();
  expect(undone).not.toBe(typed);
  await page.keyboard.press('Meta+Shift+z');
  await expect(paragraph(page)).toHaveText(typed);
  await page.keyboard.press('Meta+5');
  await expectSection(page, 'files');
  await expect(paragraph(page)).toHaveText(typed);
  await page.locator('.ProseMirror').focus();
  await page.keyboard.press('Meta+z');
  await expect(paragraph(page)).toHaveText(undone);
  // The composer, whose undo is the browser's. Conversations is reached by a
  // click so that the key pressed inside the composer is an arrival too. The
  // browser's own undo follows the machine the test runs on, not the platform
  // the page is told it has, so its keys are ControlOrMeta; the shortcut stays
  // the client's.
  await page.locator('.nav-item[data-nav="conversations"]').click();
  await expectSection(page, 'conversations');
  const composer = page.locator('#msg-input');
  await composer.click();
  await page.keyboard.type('words to take back');
  await page.keyboard.press('ControlOrMeta+z');
  const taken = await composer.inputValue();
  expect(taken).not.toBe('words to take back');
  await page.keyboard.press('ControlOrMeta+Shift+z');
  await expect(composer).toHaveValue('words to take back');
  await page.keyboard.press('Meta+1');
  await expect(composer).toHaveValue('words to take back');
  await composer.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(composer).toHaveValue(taken);
  expect(await arrivals(page)).toEqual(['files', 'conversations', 'conversations']);
  await composer.fill('');
});

test('the retry: holding the key down leaves the view open once, with no repeated load, and each fresh press does what a click does', async ({ page }) => {
  await boot(page, 'mac');
  await page.keyboard.down('Meta');
  for (let i = 0; i < 5; i++) await page.keyboard.down('Digit7');
  await page.keyboard.up('Digit7');
  await page.keyboard.up('Meta');
  await expectSection(page, 'map');
  expect(await arrivals(page)).toEqual(['map']);
  expect(await page.evaluate(() => window.mapArrivals)).toBe(1);
  // Pressing again is asking again, as clicking again is: five clicks on the
  // open view as the control, then five presses.
  const counts = () => page.evaluate(() => ({ arrivals: window.navArrivals.length, loads: window.mapArrivals }));
  const since = (a, b) => ({ arrivals: b.arrivals - a.arrivals, loads: b.loads - a.loads });
  const start = await counts();
  for (let i = 0; i < 5; i++) await page.locator('.nav-item[data-nav="map"]').click();
  const afterClicks = await counts();
  for (let i = 0; i < 5; i++) await page.keyboard.press('Meta+7');
  await expectSection(page, 'map');
  const byClicks = since(start, afterClicks);
  expect(byClicks.arrivals).toBe(5);
  expect(since(afterClicks, await counts())).toEqual(byClicks);
});

// Two owners' routines, so the Routines panel draws a scope row for each
// beside All. Written through the real save road over the spec's own socket,
// each on a weekly slot three days out so the scheduler cannot fire one
// during the spec, and taken back afterwards.
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SCHEDULE = `every ${WEEKDAYS[(new Date().getDay() + 3) % 7]} at 07:00`;
const SCOPED = [
  { agentId: 'wren', name: 'Shortcut scope wren', prompt: 'shortcut scope e2e wren' },
  { agentId: 'default', name: 'Shortcut scope lead', prompt: 'shortcut scope e2e lead' },
];

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

test('a fresh press of the key for the open view does what a click does: back to All routines from an agent\'s scope', async ({ page }) => {
  await overWs(async ({ send, waitFor }) => {
    for (const { agentId, name, prompt } of SCOPED) {
      send({ type: 'save_routine', agentId, routine: { name, schedule: SCHEDULE, prompt, runOn: 'local' } });
      await waitFor((m) => m.type === 'routine_saved' && m.name === name);
    }
  });
  try {
    await boot(page, 'mac');
    const activeScope = () => page.locator('#sidebar-routines .scope-item.active').getAttribute('data-scope');
    const wren = page.locator('#sidebar-routines .scope-item[data-scope="wren"]');
    // By the rail, as the control.
    await page.locator('.nav-item[data-nav="routines"]').click();
    await expectSection(page, 'routines');
    await wren.click();
    await expect.poll(activeScope).toBe('wren');
    await page.locator('.nav-item[data-nav="routines"]').click();
    await expect.poll(activeScope, { message: 'a click on the rail returns to All' }).toBe('all');
    // By the key.
    await page.keyboard.press('Meta+4');
    await expectSection(page, 'routines');
    await expect.poll(activeScope).toBe('all');
    await wren.click();
    await expect.poll(activeScope).toBe('wren');
    await page.keyboard.press('Meta+4');
    await expect.poll(activeScope, { message: 'the key returns to All, as the click did' }).toBe('all');
    expect(await arrivals(page)).toEqual(['routines', 'routines', 'routines', 'routines']);
  } finally {
    await overWs(async ({ send, waitFor }) => {
      for (const { agentId, name } of SCOPED) {
        send({ type: 'delete_routine', agentId, name, occurrence: 0 });
        await waitFor((m) => m.type === 'routine_deleted' && m.name === name);
      }
    });
  }
});

test('the most common next step: from Files with a note being edited, Cmd+1 opens Conversations and saves the edit as a rail click does', async ({ page }) => {
  await bootWithNote(page, 'mac');
  // By the rail, as the control.
  await typeAtEndOfNote(page, ' left by a click');
  await page.locator('.nav-item[data-nav="conversations"]').click();
  await expectSection(page, 'conversations');
  await expect.poll(readNote).toContain('left by a click');
  // By the key.
  await page.locator('.nav-item[data-nav="files"]').click();
  await expect(paragraph(page)).toHaveText('A paragraph to edit. left by a click');
  await typeAtEndOfNote(page, ' left by a key');
  await page.keyboard.press('Meta+1');
  await expectSection(page, 'conversations');
  await expect.poll(readNote).toContain('left by a click left by a key');
  expect(await arrivals(page)).toEqual(['conversations', 'files', 'conversations']);
});

test('the control failing: with the platform unreadable the modifier falls back to Ctrl and the hints say Ctrl', async ({ page }) => {
  await boot(page, 'unreadable');
  expect(await page.evaluate(() => [navigator.platform, typeof navigator.userAgentData])).toEqual(['', 'undefined']);
  const team = page.locator('.nav-main [data-nav="team"]');
  const settings = page.locator('.nav-rail [data-nav="settings"]');
  await expect(team).toHaveAttribute('data-tooltip', 'Team (Ctrl 2)');
  await expect(team).toHaveAttribute('aria-keyshortcuts', 'Control+2');
  await expect(settings).toHaveAttribute('data-tooltip', 'Settings (Ctrl ,)');
  await expect(settings).toHaveAttribute('aria-keyshortcuts', 'Control+,');
  await expectUntouched(page, 'Meta+2', 'conversations');
  await page.keyboard.press('Control+2');
  await expectSection(page, 'team');
  await page.keyboard.press('Control+Comma');
  await expectSection(page, 'settings');
  expect(await arrivals(page)).toEqual(['team', 'settings']);
});
