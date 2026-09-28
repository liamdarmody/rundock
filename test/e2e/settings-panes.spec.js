'use strict';
// The Permissions and Extensions settings panes in a real engine, against the
// real server: where each control sits, that no row is dimmed, that every
// control shows a focus ring under the keyboard, and that each switch has a
// target of at least 24 by 24. The unit suites prove what is rendered and sent;
// only layout and computed style need an engine.
const base = require('@playwright/test');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { appendRawCoverage, writeLcov, isClientEntry } = require('./coverage.js');

const test = base.test.extend({
  page: async ({ page }, use) => {
    await page.coverage.startJSCoverage({ resetOnNavigation: false });
    await use(page);
    const entries = await page.coverage.stopJSCoverage();
    appendRawCoverage(entries.filter(e => isClientEntry(e.url)));
  },
});
const { expect } = base;

let restoreStore = null;
let updateRepo = null;
test.afterAll(async () => {
  if (restoreStore) restoreStore();
  if (updateRepo) fs.rmSync(updateRepo, { recursive: true, force: true });
  await writeLcov();
});

function write(root, rel, content) {
  const absolute = path.join(root, rel);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content);
}

// Four installed extensions: one on, one off, and two declaring neither an
// entry nor a claim, which the roster reads as ones that could not load. One
// of those two names its source, so its package is known (the record alone
// makes it a package card); the other names none, so its package is not.
// With `update`, a fifth, on, whose package has a newer release tag in the
// local repository the fixture organisation is rewritten to, so the check
// Packages runs when it opens reports an update, exactly as a real one would.
// The store as it was before the first seed is put back afterwards, because
// the workspace is shared with every other spec.
function seedExtensions(workspace, { update = false } = {}) {
  const store = path.join(workspace, '.rundock/extensions.json');
  if (!restoreStore) {
    const before = fs.existsSync(store) ? fs.readFileSync(store) : null;
    restoreStore = () => { if (before) fs.writeFileSync(store, before); else fs.rmSync(store, { force: true }); };
  }
  const record = (name, extra) => ({
    name, version: '1.0.0', entry: 'index.js', match: `*.${name}`,
    source: { url: `https://github.com/e2e-fixture/${name}`, reference: 'v1.0.0' },
    installedAt: new Date(Date.now() - 2 * 86400000).toISOString(), root: `.rundock/extensions/${name}`, ...extra,
  });
  for (const name of ['layout-on', 'layout-off', ...(update ? ['layout-update'] : [])]) {
    write(workspace, `.rundock/extensions/${name}/rundock.json`, JSON.stringify({ name, version: '1.0.0', extension: { entry: 'index.js', match: `*.${name}` } }));
    write(workspace, `.rundock/extensions/${name}/index.js`, "parent.postMessage({ type: 'ready' }, '*');");
  }
  if (update) {
    updateRepo = path.join(workspace, '..', 'repos', 'layout-update');
    fs.rmSync(updateRepo, { recursive: true, force: true });
    write(updateRepo, 'rundock.json', JSON.stringify({ name: 'layout-update', version: '1.1.0', extension: { entry: 'index.js', match: '*.layout-update' } }));
    write(updateRepo, 'index.js', "parent.postMessage({ type: 'ready' }, '*');");
    const git = (...args) => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=e2e', ...args], { cwd: updateRepo, stdio: 'ignore' });
    git('init', '--quiet'); git('add', '.'); git('commit', '--quiet', '-m', 'extension'); git('tag', 'v1.0.0'); git('tag', 'v1.1.0');
  }
  write(workspace, '.rundock/extensions.json', JSON.stringify({
    schema: 'rundock.extensions/v1',
    extensions: [
      record('layout-on'), record('layout-off', { enabled: false }), record('layout-gone', { entry: undefined, match: undefined }),
      record('layout-orphan', { entry: undefined, match: undefined, source: undefined }),
      ...(update ? [record('layout-update')] : []),
    ],
  }, null, 2) + '\n');
}

async function boot(page) {
  await page.goto('/');
  await expect(page.locator('.convo-item').first()).toBeVisible();
}
async function openSection(page, section) {
  await page.locator('.nav-item[data-nav="settings"]').click();
  await page.locator(`.settings-nav-item[data-settings="${section}"]`).click();
}
// Keyboard modality first, so :focus-visible reflects a keyboard user.
async function focusRing(page, locator) {
  await page.keyboard.press('Shift');
  await locator.focus();
  return locator.evaluate((el) => ({ visible: el.matches(':focus-visible'), outline: getComputedStyle(el).outlineStyle, width: parseFloat(getComputedStyle(el).outlineWidth) }));
}
async function box(locator) { return locator.boundingBox(); }

test('Extensions: one control column per row, every switch on one right edge, a row that could not load with an empty column, nothing dimmed, in both themes', async ({ page }) => {
  await boot(page);
  const workspace = await page.evaluate(() => currentWorkspacePath);
  seedExtensions(workspace);
  await page.reload();
  await boot(page);
  await openSection(page, 'extensions');
  const rows = page.locator('.ext-page-row');
  await expect(rows).toHaveCount(4);
  await expect(page.locator('.ext-page-row[data-extension="layout-gone"] .ext-page-chip')).toHaveText('Couldn\'t load');
  await expect(page.locator('.ext-page-row[data-extension="layout-orphan"] .ext-page-chip')).toHaveText('Couldn\'t load');

  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.body.classList.toggle('light', t === 'light'), theme);
    const rights = [];
    for (let i = 0; i < 4; i += 1) {
      const row = rows.nth(i);
      const sw = row.locator('.toggle-hit');
      if (await sw.count()) {
        const hit = await box(sw);
        rights.push(hit.x + hit.width);
        expect(hit.width, 'the switch target is at least 24 wide').toBeGreaterThanOrEqual(24);
        expect(hit.height, 'and at least 24 tall').toBeGreaterThanOrEqual(24);
      } else {
        // Removal is the package's: a row that could not load has nothing in
        // its control column, and any way to its package sits on the left.
        expect(await row.locator('.ext-page-controls > *').count(), `${theme}: the control column of a row that could not load is empty`).toBe(0);
        const way = row.locator('.ext-page-to-package');
        if (await way.count()) {
          const link = await box(way);
          const id = await box(row.locator('.ext-page-id'));
          expect(link.x + link.width, `${theme}: the way to its package lies in the left column`).toBeLessThanOrEqual(id.x + id.width + 1);
        }
      }
    }
    expect(Math.max(...rights) - Math.min(...rights), `${theme}: every control shares one right edge`).toBeLessThanOrEqual(1);
    const dimmed = await page.locator('.ext-page-row, .ext-page-row *').evaluateAll((els) => els
      .map((el) => ({ c: el.className, o: getComputedStyle(el).opacity, f: getComputedStyle(el).filter }))
      .filter((s) => s.o !== '1' || s.f !== 'none'));
    expect(dimmed, `${theme}: nothing in a row is dimmed`).toEqual([]);
  }
  await page.evaluate(() => document.body.classList.remove('light'));

  const list = await box(page.locator('#extensions-list'));
  const pause = await box(page.locator('.ext-pause'));
  expect(pause.y, 'the pause control sits below the list').toBeGreaterThan(list.y + list.height);

  for (const target of [
    page.locator('.settings-nav-item[data-settings="extensions"]'),
    page.locator('.ext-page-row[data-extension="layout-on"] [role="switch"]'),
    page.locator('.ext-page-row[data-extension="layout-gone"] .ext-page-to-package'),
    page.locator('#ext-pause'),
  ]) {
    const ring = await focusRing(page, target);
    expect(ring.visible && ring.outline !== 'none' && ring.width >= 2, 'a visible focus ring').toBe(true);
  }
});

test('Extensions: a row that could not load links "its package" to that package\'s card when the package is known, and offers nothing to press when it is not', async ({ page }) => {
  await boot(page);
  const workspace = await page.evaluate(() => currentWorkspacePath);
  seedExtensions(workspace);
  await page.reload();
  await boot(page);
  await openSection(page, 'extensions');

  const orphan = page.locator('.ext-page-row[data-extension="layout-orphan"]');
  await expect(orphan.locator('.ext-page-failed')).toHaveText('Rundock couldn\'t load this extension. Rundock can\'t tell which package installed it.');
  await expect(orphan.locator('button, a, input, [role="switch"], [onclick]')).toHaveCount(0);

  const gone = page.locator('.ext-page-row[data-extension="layout-gone"]');
  await expect(gone.locator('.ext-page-failed')).toHaveText('Rundock couldn\'t load this extension. Uninstall it from its package.');
  await expect(gone.locator('.ext-page-controls > *')).toHaveCount(0);
  const link = gone.locator('.ext-page-failed .ext-page-to-package');
  await expect(link).toHaveText('its package');
  await link.click();
  await expect(page.locator('.settings-nav-item.active')).toHaveAttribute('data-settings', 'packages');
  const card = page.locator('.pkg-card-row[data-package="https://github.com/e2e-fixture/layout-gone"]');
  await expect(card).toBeFocused();
  await expect(card).toBeInViewport();
});

// The switches the update fixture shows, and the position each is set to.
const POSITIONS = { 'layout-on': true, 'layout-off': false, 'layout-update': true };
const switchOf = (page, name) => page.locator(`.ext-page-row[data-extension="${name}"] [role="switch"]`);

// Every element Tab lands on inside the settings pane, once through it from
// the sidebar, named by its accessible name, else its id, else its text.
async function tabStopsInPane(page) {
  await page.locator('.settings-nav-item').first().focus();
  const stops = [];
  for (let i = 0; i < 200; i += 1) {
    await page.keyboard.press('Tab');
    const stop = await page.evaluate(() => {
      const el = document.activeElement;
      if (!el || !el.closest('#settings-content')) return null;
      return el.getAttribute('aria-label') || el.id || el.textContent.trim();
    });
    if (stop === null && stops.length) return stops;
    if (stop !== null) stops.push(stop);
  }
  return stops;
}

// Every row, and everything in it, at opacity 1 with no filter. The one
// exception allowed is the switch itself while disabled: its row and its
// text stay undimmed. Reported by row and class so a failure names the culprit.
async function dimmedInRows(page) {
  return page.locator('.ext-page-row, .ext-page-row *').evaluateAll((els) => els
    .filter((el) => !(el.matches('input[role="switch"]') && el.disabled))
    .map((el) => ({ row: (el.closest('.ext-page-row') || el).dataset.extension, c: String(el.className), o: getComputedStyle(el).opacity, f: getComputedStyle(el).filter }))
    .filter((s) => s.o !== '1' || s.f !== 'none'));
}

// Opening Packages runs the check; the Extensions page learns the answer from
// the same state and shows the update line, which is only ever a way there.
async function openWithUpdateAvailable(page) {
  const workspace = await page.evaluate(() => currentWorkspacePath);
  seedExtensions(workspace, { update: true });
  await page.reload();
  await boot(page);
  await openSection(page, 'packages');
  await expect(page.locator('.pkg-card-row[data-package="https://github.com/e2e-fixture/layout-update"] .pkg-card-status')).toHaveText('Update available: v1.1.0', { timeout: 15_000 });
  await page.locator('.settings-nav-item[data-settings="extensions"]').click();
  const update = page.locator('.ext-page-row[data-extension="layout-update"]');
  await expect(update.locator('.ext-page-update')).toHaveText('Update available in Packages');
  for (const name of ['layout-on', 'layout-off']) await expect(page.locator(`.ext-page-row[data-extension="${name}"] .ext-page-update`)).toHaveCount(0);
  return update;
}

test('Extensions: with an update available, the row\'s control column still holds only its switch, the update link sits left of it, and every switch shares one right edge', async ({ page }) => {
  await boot(page);
  const update = await openWithUpdateAvailable(page);
  await expect(page.locator('.ext-page-row[data-extension="layout-on"] .onoff-label')).toHaveText('On');
  await expect(page.locator('.ext-page-row[data-extension="layout-off"] .onoff-label')).toHaveText('Off');
  await expect(update.locator('.onoff-label')).toHaveText('On');

  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.body.classList.toggle('light', t === 'light'), theme);
    const rights = {};
    for (const name of ['layout-on', 'layout-off', 'layout-update']) {
      const row = page.locator(`.ext-page-row[data-extension="${name}"]`);
      // The column's only interactive element is the switch, named by the
      // extension; its only text is the On or Off beside it.
      const interactive = await row.locator('.ext-page-controls').evaluate((col) => [...col.querySelectorAll('a, button, input, select, textarea, [role], [tabindex], [onclick]')]
        .map((el) => ({ tag: el.tagName, role: el.getAttribute('role'), name: el.getAttribute('aria-label') })));
      expect(interactive, `${theme}: ${name}'s control column holds only its switch`).toEqual([{ tag: 'INPUT', role: 'switch', name }]);
      expect((await row.locator('.ext-page-controls').innerText()).trim(), `${theme}: and no text but On or Off`).toMatch(/^(On|Off)$/);
      const hit = await box(row.locator('.toggle-hit'));
      rights[name] = hit.x + hit.width;
    }
    const edges = Object.values(rights);
    expect(Math.max(...edges) - Math.min(...edges), `${theme}: every switch shares one right edge, the update row's included (${JSON.stringify(rights)})`).toBeLessThanOrEqual(1);

    // The update line is in the left column, wholly left of the control column.
    const link = await box(update.locator('.ext-page-update .linkbtn'));
    const column = await box(update.locator('.ext-page-controls'));
    expect(await update.locator('.ext-page-controls .ext-page-update, .ext-page-controls .linkbtn').count(), `${theme}: the update line is not in the control column`).toBe(0);
    expect(await update.locator('.ext-page-id .ext-page-update').count(), `${theme}: it sits under the extension's description`).toBe(1);
    expect(link.x + link.width, `${theme}: the update link lies left of the control column`).toBeLessThanOrEqual(column.x + 1);
  }
  await page.evaluate(() => document.body.classList.remove('light'));

  // The link is a way to Packages, never an update.
  await update.locator('.ext-page-update .linkbtn').click();
  await expect(page.locator('.settings-nav-item.active')).toHaveAttribute('data-settings', 'packages');
  expect(JSON.parse(fs.readFileSync(path.join(await page.evaluate(() => currentWorkspacePath), '.rundock/extensions.json'), 'utf8'))
    .extensions.find((e) => e.name === 'layout-update').version, 'nothing was updated').toBe('1.0.0');
});

test('Extensions: no row or text is dimmed with an update available or while paused; only a disabled switch may look disabled', async ({ page }) => {
  await boot(page);
  const update = await openWithUpdateAvailable(page);
  const rows = page.locator('.ext-page-row');
  await expect(rows).toHaveCount(5);

  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.body.classList.toggle('light', t === 'light'), theme);
    expect(await dimmedInRows(page), `${theme}, update available: nothing in a row is dimmed`).toEqual([]);
  }
  await page.evaluate(() => document.body.classList.remove('light'));

  await page.locator('#ext-pause').click();
  await expect(page.locator('.ext-paused-banner p')).toHaveText('All extensions are paused. Each one goes back to its own setting when you resume.');
  // Paused, every switch is disabled in the disabled style, still showing its
  // own position and named as paused.
  for (const [name, checked] of Object.entries(POSITIONS)) {
    const sw = switchOf(page, name);
    await expect(sw, `${name}, paused: its switch is disabled`).toBeDisabled();
    await expect(sw).toHaveAttribute('aria-label', `${name}, paused`);
    expect(await sw.isChecked(), `${name}, paused: its switch shows its own position`).toBe(checked);
    expect(await sw.evaluate((el) => el.matches('.rui-toggle:disabled') && getComputedStyle(el).opacity !== '1'), `${name}, paused: the switch takes the disabled style`).toBe(true);
  }
  // Paused keeps each row's own setting and its update line.
  await expect(page.locator('.ext-page-row[data-extension="layout-off"] .onoff-label')).toHaveText('Off');
  await expect(update.locator('.onoff-label')).toHaveText('On');
  await expect(update.locator('.ext-page-update')).toHaveText('Update available in Packages');
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.body.classList.toggle('light', t === 'light'), theme);
    expect(await dimmedInRows(page), `${theme}, paused: nothing in a row is dimmed`).toEqual([]);
    // Every row, and the update row's text in particular, measured directly,
    // so an empty selector can never pass the check above by matching nothing.
    const styles = await page.locator('.ext-page-row, .ext-page-row[data-extension="layout-update"] :is(.ext-page-name, .ext-page-ver, .ext-page-added, .ext-page-from, .ext-page-update, .onoff-label)')
      .evaluateAll((els) => els.map((el) => [getComputedStyle(el).opacity, getComputedStyle(el).filter]));
    expect(styles.length, `${theme}: five rows and six text elements of the update row measured`).toBe(11);
    expect(styles.every(([o, f]) => o === '1' && f === 'none'), `${theme}, paused: every row and the update row's text are undimmed`).toBe(true);
  }
  await page.evaluate(() => document.body.classList.remove('light'));

  await page.locator('#ext-resume').click();
  await expect(page.locator('#ext-pause')).toBeVisible();
  await expect(page.locator('.ext-paused-banner')).toHaveCount(0);
  // Resumed, each switch is pressable again, in exactly the position it had.
  for (const [name, checked] of Object.entries(POSITIONS)) {
    const sw = switchOf(page, name);
    await expect(sw, `${name}, resumed: its switch is pressable`).toBeEnabled();
    await expect(sw).toHaveAttribute('aria-label', name);
    expect(await sw.isChecked(), `${name}, resumed: its own position`).toBe(checked);
  }
});

test('Extensions: a click on a paused switch sends nothing and changes nothing', async ({ page }) => {
  const sent = [];
  page.on('websocket', (socket) => socket.on('framesent', (frame) => {
    try { sent.push(JSON.parse(String(frame.payload))); } catch { /* not a message */ }
  }));
  await boot(page);
  const workspace = await page.evaluate(() => currentWorkspacePath);
  seedExtensions(workspace);
  await page.reload();
  await boot(page);
  await openSection(page, 'extensions');
  const store = path.join(workspace, '.rundock/extensions.json');
  // Compared by name: the store may be rewritten in another order, which is not a change to anyone's setting.
  const settings = () => JSON.parse(fs.readFileSync(store, 'utf8')).extensions
    .map((e) => [e.name, e.enabled !== false])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const before = settings();

  await page.locator('#ext-pause').click();
  await expect(page.locator('.ext-paused-banner')).toBeVisible();
  const positions = { 'layout-on': true, 'layout-off': false };
  sent.length = 0;
  for (const name of Object.keys(positions)) {
    const row = page.locator(`.ext-page-row[data-extension="${name}"]`);
    // Forced past the engine's wait for an enabled control, so the pointer
    // really lands on the switch and on the target around it.
    await row.locator('[role="switch"]').click({ force: true });
    await row.locator('.toggle-hit').click({ force: true });
  }
  for (const [name, checked] of Object.entries(positions)) {
    const sw = switchOf(page, name);
    await expect(sw, `${name}: still disabled after the click`).toBeDisabled();
    expect(await sw.isChecked(), `${name}: still in its own position`).toBe(checked);
    await expect(page.locator(`.ext-page-row[data-extension="${name}"] .onoff-label`)).toHaveText(checked ? 'On' : 'Off');
  }

  // Resume is answered after anything the clicks could have sent, so by the
  // time it lands every such message would have been sent and written.
  await page.locator('#ext-resume').click();
  await expect(page.locator('#ext-pause')).toBeVisible();
  expect(sent.filter((m) => m.type === 'set_extensions_all_off'), 'the capture sees what the page sends').toEqual([{ type: 'set_extensions_all_off', off: false }]);
  expect(sent.filter((m) => m.type === 'set_extension_enabled'), 'a paused switch sent nothing').toEqual([]);
  expect(settings(), 'no extension\'s own setting changed').toEqual(before);
  for (const [name, checked] of Object.entries(positions)) {
    await expect(switchOf(page, name)).toBeEnabled();
    expect(await switchOf(page, name).isChecked(), `${name}, resumed: its own position`).toBe(checked);
  }
});

// The indicator drawn around an element: its outline and its box-shadow.
const indicatorOf = (el) => {
  const s = getComputedStyle(el);
  return { outline: `${s.outlineStyle} ${s.outlineWidth} ${s.outlineColor}`, outlineStyle: s.outlineStyle, outlineWidth: parseFloat(s.outlineWidth), shadow: s.boxShadow };
};

// Reached by the keyboard alone: Tab from where the page leaves focus until the
// element holds focus, so :focus-visible is the engine's own keyboard verdict.
async function tabTo(page, locator) {
  const target = await locator.elementHandle();
  await page.locator('.settings-nav-item').first().focus();
  for (let i = 0; i < 200; i += 1) {
    if (await target.evaluate((el) => document.activeElement === el)) return;
    await page.keyboard.press('Tab');
  }
  throw new Error('Tab never reached the element');
}

// Unfocused, then keyboard-focused: the element must match :focus-visible and
// draw an outline or a box-shadow it did not draw before, in each theme.
async function expectKeyboardIndicator(page, locator, name) {
  await expect(locator, `${name} is on the page`).toHaveCount(1);
  for (const theme of ['dark', 'light']) {
    await page.evaluate((t) => document.body.classList.toggle('light', t === 'light'), theme);
    await page.mouse.move(0, 0);
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
    const before = await locator.evaluate(indicatorOf);
    await tabTo(page, locator);
    const focused = { visible: await locator.evaluate((el) => el.matches(':focus-visible')), ...await locator.evaluate(indicatorOf) };
    expect(focused.visible, `${theme}: ${name} matches :focus-visible under the keyboard`).toBe(true);
    const ring = focused.outlineStyle !== 'none' && focused.outlineWidth >= 2 && focused.outline !== before.outline;
    const shadow = focused.shadow !== 'none' && focused.shadow !== before.shadow;
    expect(ring || shadow, `${theme}: ${name} draws a focus indicator it did not draw unfocused (before ${JSON.stringify(before)}, focused ${JSON.stringify(focused)})`).toBe(true);
  }
  await page.evaluate(() => document.body.classList.remove('light'));
}

test('Extensions: every interactive element, on, off, could not load, with an update, paused and empty, shows a focus indicator under the keyboard in both themes', async ({ page }) => {
  await boot(page);
  const update = await openWithUpdateAvailable(page);
  const row = (name) => page.locator(`.ext-page-row[data-extension="${name}"]`);

  await expectKeyboardIndicator(page, page.locator('.settings-nav-item[data-settings="extensions"]'), 'the sidebar item');
  await expectKeyboardIndicator(page, row('layout-on').locator('[role="switch"]'), 'the switch of an extension that is on');
  await expectKeyboardIndicator(page, row('layout-off').locator('[role="switch"]'), 'the switch of an extension that is off');
  await expectKeyboardIndicator(page, update.locator('[role="switch"]'), 'the switch of an extension with an update');
  await expectKeyboardIndicator(page, update.locator('.ext-page-update .linkbtn'), 'the Update available link');
  await expectKeyboardIndicator(page, row('layout-gone').locator('.ext-page-to-package'), 'the "its package" link of a row that could not load');
  const provenance = page.locator('.ext-page-from .linkbtn');
  const links = await provenance.count();
  expect(links, 'every row whose package is known links to it').toBeGreaterThanOrEqual(3);
  for (let i = 0; i < links; i += 1) await expectKeyboardIndicator(page, provenance.nth(i), `package link ${i + 1}`);
  await expectKeyboardIndicator(page, page.locator('#ext-pause'), 'Pause all extensions');

  // Running, Tab reaches every switch: the walk below can see them.
  const running = await tabStopsInPane(page);
  for (const name of Object.keys(POSITIONS)) expect(running, `running: Tab reaches the switch of ${name}`).toContain(name);

  await page.locator('#ext-pause').click();
  await expect(page.locator('.ext-paused-banner')).toBeVisible();
  // Paused, a switch is disabled, so it has no focus to show: Tab passes it by
  // while still reaching Resume and the links in the rows.
  const paused = await tabStopsInPane(page);
  expect(paused, 'paused: Tab reaches Resume extensions').toContain('ext-resume');
  expect(paused, 'paused: and the update link in a row').toContain('Update available in Packages');
  for (const [name, checked] of Object.entries(POSITIONS)) {
    await expect(switchOf(page, name), `${name}, paused: its switch is disabled`).toBeDisabled();
    expect(await switchOf(page, name).isChecked(), `${name}, paused: its switch shows its own position`).toBe(checked);
    expect(paused, `paused: Tab never lands on the switch of ${name}`).not.toContain(`${name}, paused`);
  }
  await expectKeyboardIndicator(page, page.locator('#ext-resume'), 'Resume extensions');

  // The switch target is measured again here, in every state that has one.
  for (const name of ['layout-on', 'layout-off', 'layout-update']) {
    const hit = await box(row(name).locator('.toggle-hit'));
    expect(hit.width, `${name}: the switch target is at least 24 wide`).toBeGreaterThanOrEqual(24);
    expect(hit.height, `${name}: and at least 24 tall`).toBeGreaterThanOrEqual(24);
  }
  await page.locator('#ext-resume').click();
  await expect(page.locator('#ext-pause')).toBeVisible();

  // With nothing installed, the one control is the way to Packages.
  const workspace = await page.evaluate(() => currentWorkspacePath);
  write(workspace, '.rundock/extensions.json', JSON.stringify({ schema: 'rundock.extensions/v1', extensions: [] }, null, 2) + '\n');
  await page.reload();
  await boot(page);
  await openSection(page, 'extensions');
  await expectKeyboardIndicator(page, page.locator('.ext-page-empty .linkbtn'), 'Go to Packages');
});

test('Permissions: the switch has a 24px target and every control a focus ring; turning off asks first', async ({ page }) => {
  await boot(page);
  await openSection(page, 'permissions');
  const row = page.locator('#sandbox-row .wall-row');
  await expect(row).toBeVisible();
  const state = await page.locator('#sandbox-state').textContent();
  const sw = page.locator('#sandbox-switch');
  // On macOS the shared fixture workspace is one Rundock opened, so its row is
  // a real switch and that branch below is exercised, not skipped.
  if (process.platform === 'darwin') expect(await sw.count()).toBe(1);
  const targets = [page.locator('.mode-toggle-btn.active'), page.locator('#wf-input + .settings-btn')];
  if (await sw.count()) {
    const hit = await box(page.locator('#sandbox-row .toggle-hit'));
    expect(hit.width).toBeGreaterThanOrEqual(24);
    expect(hit.height).toBeGreaterThanOrEqual(24);
    targets.push(sw);
  }
  for (const target of targets) {
    const ring = await focusRing(page, target);
    expect(ring.visible && ring.outline !== 'none' && ring.width >= 2, 'a visible focus ring').toBe(true);
  }
  if (await sw.count() && state === 'On') {
    await sw.click();
    await expect(page.locator('.wall-confirm p')).toHaveText('Turn off? Agents will be able to change or delete files outside this workspace wherever your account allows. Rundock will still ask before each change there, unless a folder is added below.');
    const keep = page.locator('#sandbox-keep-on');
    const ring = await focusRing(page, keep);
    expect(ring.visible && ring.outline !== 'none').toBe(true);
    await page.keyboard.press('Escape');
    await expect(page.locator('.wall-confirm')).toHaveCount(0);
    await expect(page.locator('#sandbox-state')).toHaveText('On');
  }
});
