// The refreshed shot list: one scene per id (IMG-01 to IMG-19), each driving
// the real app into the state its shot shows. Ids are the file names, so a
// placement can be traced from an image back to the scene that made it.
//
// Fields, beyond capture.mjs's `name`, `feature`, `hero`, `crop`, `setup`:
//   id        the shot-list id the files are named by.
//   variant   which demo workspace the scene runs against ('main' when
//             absent); see VARIANTS in generate-workspace.mjs.
//   tile      async (page, outPath) => boolean. Writes an element-scoped tile
//             itself, for a tile no single selector describes.
//
// Seeding in the page is kept to what cannot be held on disk (a run in
// flight, a pending permission request, the sandbox's platform status) and
// goes through the app's own functions, so what is drawn is what the app
// draws for that state.

import {
  openFile, openSettings, seedWorking, seedLastActive, fitOrgChart,
  waitForMapSettled, redrawSettingsAsDesktopApp, withTallViewport, centreMapOn, parkPointer,
} from './harness.mjs';
import { DEMO_IDS } from './generate-workspace.mjs';
import { LAUNCH_PLAN_REL, LINKED_NOTE_RELS, DASHBOARD_REL } from './demo-content.mjs';
import { PACKAGES, PACKAGE_ORG } from './demo-packages.mjs';

const PAD = 24;

// Screenshots `clip` (page coordinates) clamped to the viewport.
async function shootClip(page, outPath, clip) {
  const vp = page.viewportSize();
  const x = Math.max(0, Math.floor(clip.x));
  const y = Math.max(0, Math.floor(clip.y));
  const width = Math.min(vp.width - x, Math.ceil(clip.width));
  const height = Math.min(vp.height - y, Math.ceil(clip.height));
  if (width < 8 || height < 8) return false;
  await page.screenshot({ path: outPath, clip: { x, y, width, height }, animations: 'disabled' });
  return true;
}

// The bounding box that holds every given element, padded.
async function unionBox(page, selectors) {
  return page.evaluate(({ selectors, pad }) => {
    const boxes = selectors.map((s) => document.querySelector(s)).filter(Boolean).map((el) => el.getBoundingClientRect());
    if (!boxes.length) return null;
    const left = Math.min(...boxes.map((b) => b.left)) - pad;
    const top = Math.min(...boxes.map((b) => b.top)) - pad;
    const right = Math.max(...boxes.map((b) => b.right)) + pad;
    const bottom = Math.max(...boxes.map((b) => b.bottom)) + pad;
    return { x: left, y: top, width: right - left, height: bottom - top };
  }, { selectors, pad: PAD });
}

// Waits until the open file's extension frame has drawn Rundock UI
// components, then a moment more for its layout to settle.
async function drawnInFrame(page) {
  await page.frameLocator('#editor-content iframe.extension-frame')
    .locator('.rui-stat, .rui-table, [class*="rui-board"]').first().waitFor({ timeout: 15000 });
  await page.waitForTimeout(800);
}

// The team chart with live status: Dev working, Cleo active a few minutes
// ago, everyone else idle. The layout is a remembered choice, and every shot
// in a theme shares one browser context, so each scene sets the layout it
// shows rather than inheriting the last scene's, through the chart's own
// button.
async function teamWithStatus(page, layout = 'vertical') {
  await page.evaluate(() => switchNav('team'));
  await page.waitForSelector('.org-card', { timeout: 10000 });
  const switchTo = layout === 'vertical' ? 'Switch to top-down layout' : 'Switch to left-to-right layout';
  const button = page.locator(`.org-zoom .org-orient[aria-label="${switchTo}"]`);
  if (await button.count()) {
    await button.click();
    // Switching focuses the button for keyboard use; a still shows no focus
    // ring nobody asked for.
    await page.evaluate(() => document.activeElement && document.activeElement.blur());
  }
  await seedWorking(page, ['dev']);
  await seedLastActive(page, { cleo: '2026-07-18T11:56:00.000Z' });
}

// A permission request raised by an agent editing a file outside the
// workspace, in the shape the permission hook sends.
function outsideWriteRequest(id, toolName, file, folder, input) {
  return {
    request_id: id,
    request: {
      tool_name: toolName,
      input: { file_path: file, ...input },
      boundary: true,
      resolved_path: file,
      grant_dir: folder,
      crossings: [{ path: file, write: true }],
    },
  };
}

// The Conversations view narrowed to the Launch list: every list pill in the
// filter row, Launch selected through its own pill, and Plan the week (in
// Launch and Ops) open. A pill's filter is in-memory, so each scene sets it.
async function launchListOpen(page) {
  await page.evaluate(() => switchNav('conversations'));
  await page.waitForSelector('#sidebar-pills .pill-list[data-pill="list:ops"]', { timeout: 10000 });
  await page.evaluate((id) => openConversation(id), DEMO_IDS.convos.planWeek);
  await page.waitForSelector('#messages .msg', { timeout: 10000 });
  await page.click('#sidebar-pills .pill-list[data-pill="list:launch"]');
  await page.waitForFunction(() => document.querySelectorAll('#convo-list [oncontextmenu][data-convo-id]').length === 3, null, { timeout: 5000 });
  // Clicking focuses the pill; a still shows no focus ring nobody asked for.
  await page.evaluate(() => document.activeElement && document.activeElement.blur());
  await parkPointer(page);
  await page.waitForTimeout(300);
}

export const REFRESH_SHOTS = [
  {
    id: 'IMG-01', name: 'IMG-01-org-chart', hero: true, feature: 'Team: org chart with live status and the layout switch',
    crop: '#org-chart',
    async setup(page) {
      await teamWithStatus(page);
      await fitOrgChart(page);
    },
  },
  {
    id: 'IMG-02', name: 'IMG-02-org-chart-sideways', feature: 'Team: the chart on its side',
    async setup(page) {
      await teamWithStatus(page, 'horizontal');
      await fitOrgChart(page);
    },
  },
  {
    id: 'IMG-03', name: 'IMG-03-pins', feature: 'Pins, with a pinned board open',
    async setup(page) {
      await page.click('.nav-item[data-nav="pins"]');
      await page.waitForSelector('#pin-list .pin-item.active', { timeout: 10000 });
      await page.waitForSelector('.board-lane', { timeout: 10000 });
      // The click leaves the pointer on the rail, whose tooltip would show.
      await parkPointer(page);
      await page.waitForTimeout(400);
    },
  },
  {
    id: 'IMG-04', name: 'IMG-04-map', feature: 'Map, hovering a hub note',
    async setup(page) {
      await page.click('.nav-item[data-nav="map"]');
      await waitForMapSettled(page, LAUNCH_PLAN_REL);
      await centreMapOn(page, LINKED_NOTE_RELS);
      const at = await page.evaluate((p) => mapNodeScreenPosition(p), LAUNCH_PLAN_REL);
      await page.mouse.move(at.x, at.y);
      await page.waitForFunction(() => /Launch Plan/.test(document.querySelector('#graph-readout b')?.textContent || ''), null, { timeout: 5000 });
      await page.waitForTimeout(200);
    },
  },
  {
    // Hover dims every node but the hovered one's neighbours, which mutes the
    // recency shading, so the map is also captured with nothing hovered.
    id: 'IMG-04', name: 'IMG-04-map-nohover', feature: 'Map, nothing hovered',
    async setup(page) {
      await page.click('.nav-item[data-nav="map"]');
      await waitForMapSettled(page, LAUNCH_PLAN_REL);
      await centreMapOn(page, LINKED_NOTE_RELS);
    },
  },
  {
    id: 'IMG-05', name: 'IMG-05-connections', feature: 'Connections list on a note',
    async setup(page) {
      await openFile(page, LAUNCH_PLAN_REL);
      await page.waitForSelector('#file-connections .file-connections-group', { timeout: 10000 });
      await page.evaluate(() => document.getElementById('file-connections').scrollIntoView({ block: 'center' }));
      await page.waitForTimeout(300);
    },
    // The list and a few lines of the note above it.
    async tile(page, outPath) {
      const box = await unionBox(page, ['#file-connections']);
      if (!box) return false;
      return shootClip(page, outPath, { ...box, y: box.y - 140, height: box.height + 140 });
    },
  },
  {
    id: 'IMG-06', name: 'IMG-06-packages', variant: 'packages', feature: 'Settings, Packages: installed packages',
    async setup(page) {
      await openSettings(page, 'packages');
      await page.waitForSelector('#packages-installed .pkg-card-row', { timeout: 10000 });
      // Opening the page checks every package for a newer release; Lean
      // Agent Team's local repository has one.
      const lean = `https://github.com/${PACKAGE_ORG}/${PACKAGES.leanAgentTeam.repo}`;
      await page.waitForFunction((id) => /Update available/.test(document.querySelector(`.pkg-card-row[data-package="${id}"] .pkg-card-status`)?.textContent || ''), lean, { timeout: 20000 });
      await page.waitForTimeout(300);
    },
  },
  {
    id: 'IMG-07', name: 'IMG-07-install-review', feature: 'Install review for a package with an extension',
    async setup(page) {
      await openSettings(page, 'packages');
      await page.fill('#packages-source-link', `https://github.com/${PACKAGE_ORG}/${PACKAGES.investmentPartner.repo}`);
      await page.click('.pkg-add .settings-btn-primary');
      await page.waitForSelector('.extension-trust-card', { timeout: 20000 });
      // The trust card names what the desktop app blocks; a browser draws a
      // different sentence. Redrawing keeps the install flow's state.
      await redrawSettingsAsDesktopApp(page, 'packages');
      await page.waitForSelector('.extension-trust-card', { timeout: 5000 });
      await page.waitForTimeout(300);
    },
    async tile(page, outPath) {
      return withTallViewport(page, 1800, async () => {
        const el = await page.$('.extension-trust-card');
        if (!el) return false;
        await el.scrollIntoViewIfNeeded();
        await el.screenshot({ path: outPath, animations: 'disabled' });
        return true;
      });
    },
  },
  {
    id: 'IMG-08', name: 'IMG-08-extension-view', variant: 'packages', feature: 'An extension view: the Investment Partner dashboard',
    async setup(page) {
      await openFile(page, 'Investments/Investment Dashboard.md');
      await page.waitForSelector('#editor-content iframe.extension-frame', { timeout: 15000 });
      await drawnInFrame(page);
      await page.waitForTimeout(800);
    },
  },
  {
    id: 'IMG-08', name: 'IMG-08-extension-view-portfolio', variant: 'packages', feature: 'An extension view: one portfolio note on its own',
    async setup(page) {
      await openFile(page, 'Investments/Portfolio.md');
      await page.waitForSelector('#editor-content iframe.extension-frame', { timeout: 15000 });
      await drawnInFrame(page);
      await page.waitForTimeout(800);
    },
  },
  {
    // The Site's Packages and Pins hero: an extension view opened from Pins,
    // which is what Pins is for. Same framing and waits as IMG-08.
    id: 'IMG-18', name: 'IMG-18-pinned-dashboard', variant: 'packages', feature: 'Pins, with the Investment Partner dashboard open in its extension view',
    async setup(page) {
      await page.click('.nav-item[data-nav="pins"]');
      await page.waitForFunction((rel) => document.querySelector('#pin-list .pin-item.active')?.dataset.path === rel,
        DASHBOARD_REL, { timeout: 10000 });
      await page.waitForSelector('#editor-content iframe.extension-frame', { timeout: 15000 });
      await drawnInFrame(page);
      // The click leaves the pointer on the rail, whose tooltip would show.
      await parkPointer(page);
      await page.waitForTimeout(800);
    },
  },
  {
    id: 'IMG-09', name: 'IMG-09-extensions', variant: 'packages', feature: 'Settings, Extensions: one on, one off',
    crop: '#settings-content',
    async setup(page) {
      await openSettings(page, 'extensions');
      await page.waitForFunction(() => document.querySelectorAll('.ext-page-row').length === 2, null, { timeout: 10000 });
      await page.waitForTimeout(300);
    },
  },
  {
    id: 'IMG-10', name: 'IMG-10-settings-permissions', feature: 'Settings, Permissions: Code mode, the sandbox switch, a working folder, remembered answers',
    async setup(page) {
      await openSettings(page, 'permissions');
      await page.waitForSelector('#sandbox-row', { timeout: 10000 });
      await page.waitForSelector('.wf-row', { timeout: 10000 });
      await page.waitForFunction(() => document.querySelectorAll('#tool-allows-block .tool-allow-row').length === 2, null, { timeout: 10000 });
      // The server's own answer first, so it cannot land after the one below.
      await page.waitForFunction(() => !/Checking/.test(document.getElementById('sandbox-state')?.textContent || 'Checking'), null, { timeout: 10000 }).catch(() => {});
      // The switch's state comes from the machine's Claude Code, which a
      // capture machine may not have: the status a sandbox-capable Mac
      // reports for a Rundock-managed switch that is on is given here.
      await page.evaluate(() => sandboxStatusArrived({ platform: 'darwin', available: true, on: true, present: true, managed: true }));
      await page.waitForTimeout(300);
    },
    // The whole pane, which runs past one screen.
    async tile(page, outPath) {
      return withTallViewport(page, 1800, async () => {
        const el = await page.$('#settings-content');
        if (!el) return false;
        await el.screenshot({ path: outPath, animations: 'disabled' });
        return true;
      });
    },
  },
  {
    id: 'IMG-11', name: 'IMG-11-permission-card', feature: 'A permission card for a change outside the workspace',
    async setup(page) {
      await page.evaluate(() => switchNav('conversations'));
      await page.evaluate((id) => openConversation(id), DEMO_IDS.convos.draftNote);
      await page.waitForSelector('#messages .msg', { timeout: 10000 });
      const request = outsideWriteRequest('demo-card-1', 'Edit', '~/Clients/Northwind/Proposal.md', '~/Clients/Northwind',
        { old_string: 'Three options, priced.', new_string: 'Three options, priced, with the one we recommend first.' });
      await page.evaluate(({ d, id }) => renderPermissionCard({ ...d, _conversationId: id }, id), { d: request, id: DEMO_IDS.convos.draftNote });
      await page.waitForSelector('#perm-demo-card-1', { timeout: 5000 });
      await page.waitForTimeout(300);
    },
    // The card and the message above it.
    async tile(page, outPath) {
      await page.evaluate(() => {
        const card = document.getElementById('perm-demo-card-1');
        const before = card && card.previousElementSibling;
        if (before) before.id = '__above_card';
      });
      const box = await unionBox(page, ['#__above_card', '#perm-demo-card-1']);
      return box ? shootClip(page, outPath, box) : false;
    },
  },
  {
    id: 'IMG-12', name: 'IMG-12-connectors', feature: 'Settings, Connectors across both runtimes',
    crop: '#settings-content',
    async setup(page) {
      await openSettings(page, 'connectors');
      await page.waitForSelector('[data-connector="calendar"]', { timeout: 10000 });
      await page.waitForSelector('[data-connector="tasks"]', { timeout: 10000 });
      await page.waitForTimeout(300);
    },
  },
  {
    id: 'IMG-13', name: 'IMG-13-routines', feature: 'Routines: every run state, Run now on each row',
    async setup(page) {
      await page.evaluate(() => switchNav('routines'));
      await page.waitForFunction(() => document.querySelectorAll('#routines-content .routine-row').length === 5, null, { timeout: 10000 });
      // Today's Funnel report run, still going. A run in flight lives only in
      // the server's memory, so it is given to the roster here, in the shape
      // the roster carries it.
      await page.evaluate(() => {
        const glen = agents.find((a) => a.id === 'glen');
        const routine = glen && (glen.routines || []).find((r) => r.name === 'Funnel report');
        if (!routine) throw new Error('the Funnel report routine is missing from the roster');
        routine.running = { id: 'demo-run', trigger: 'scheduled', startedAt: '2026-07-18T10:30:04.000Z' };
        routine.state = { ...(routine.state || {}), status: 'running' };
        routine.lastStart = '2026-07-18T10:30:04.000Z';
        renderRoutines();
      });
      await page.waitForSelector('#routines-content .run-status.live', { timeout: 5000 });
      // The brief's "Still going" row shows Run now greyed out as "Run in
      // progress". The roster's in-flight fact is the only thing the row
      // disables it from, so this fails loudly if that fact stops reaching
      // the row rather than capturing a live play button beside "Still going".
      await page.waitForFunction(() => {
        const row = [...document.querySelectorAll('#routines-content .routine-row')].find((r) => r.querySelector('.run-status.live'));
        const run = row && row.querySelector('.icon-btn.run');
        return !!(run && run.disabled && run.getAttribute('aria-label') === 'Run in progress');
      }, null, { timeout: 5000 });
      await page.waitForTimeout(300);
    },
    // One row, with Run now on it.
    async tile(page, outPath) {
      await page.evaluate(() => {
        const row = [...document.querySelectorAll('#routines-content .routine-row')].find((r) => /Daily brief/.test(r.textContent));
        if (row) row.id = '__tile_row';
      });
      const el = await page.$('#__tile_row');
      if (!el) return false;
      await el.screenshot({ path: outPath, animations: 'disabled' });
      return true;
    },
  },
  {
    id: 'IMG-14', name: 'IMG-14-approvals-dock', feature: 'A routine\'s permission card in the approvals dock',
    async setup(page) {
      await teamWithStatus(page);
      await fitOrgChart(page);
      const request = outsideWriteRequest('demo-dock-1', 'Write', '~/Reports/Publish Check.md', '~/Reports',
        { content: 'This week: four posts published against a plan of five.' });
      request._run = { id: 'demo-run-ana', routine: 'Publish check', agent: 'ana' };
      await page.evaluate((d) => handleOwnerlessPermissionRequest(d), request);
      await page.waitForSelector('#approvals-dock:not([hidden]) #perm-demo-dock-1', { timeout: 5000 });
      await page.waitForTimeout(300);
    },
  },
  {
    id: 'IMG-16', name: 'IMG-16-rundock-ui-gallery', feature: 'The Rundock UI component gallery, dark theme',
    // Not the workspace: the gallery is its own page.
    page: '/rundock-ui/gallery',
    async setup(page) {
      await page.frameLocator('iframe[data-theme="dark"]').locator('body[data-drawn="true"]').waitFor({ timeout: 15000 });
      await page.waitForTimeout(400);
    },
    // The dark frame's first sections: buttons, fields, tabs, a table.
    async tile(page, outPath) {
      return withTallViewport(page, 1600, async () => {
        const frame = await page.$('iframe[data-theme="dark"]');
        const box = frame && await frame.boundingBox();
        if (!box) return false;
        return shootClip(page, outPath, { x: box.x, y: box.y, width: box.width, height: 1600 - box.y - PAD });
      });
    },
  },
  {
    id: 'IMG-17', name: 'IMG-17-tutorial-tracker', feature: 'The build-an-extension tutorial\'s tracker, drawn as a board',
    crop: '#editor-content',
    async setup(page) {
      await openFile(page, 'Tracker.md');
      await page.waitForSelector('#editor-content iframe.extension-frame', { timeout: 15000 });
      await drawnInFrame(page);
    },
  },
  {
    id: 'IMG-19', name: 'IMG-19-conversation-lists', feature: 'Conversations narrowed to one list, every list pill in the filter row',
    async setup(page) {
      await launchListOpen(page);
    },
  },
  {
    // The same, with Plan the week's right-click menu open: each list with a
    // tick against those it is in (Launch and Ops), and New list… at the foot.
    // The menu opens at the pointer, so the click lands low on the row's
    // right, keeping the menu clear of the pill row.
    id: 'IMG-19', name: 'IMG-19-conversation-lists-menu', feature: 'A conversation\'s Lists menu: Launch and Ops ticked, Hiring not, New list…',
    async setup(page) {
      await launchListOpen(page);
      const row = page.locator(`#convo-list [oncontextmenu][data-convo-id="${DEMO_IDS.convos.planWeek}"]`);
      const box = await row.boundingBox();
      if (!box) throw new Error('the Plan the week row is not on screen');
      await row.click({ button: 'right', position: { x: box.width - 48, y: box.height - 12 } });
      await page.waitForSelector('#convo-context-menu .convo-menu-input input', { timeout: 5000 });
      // The menu focuses its New list… field; the still shows it empty and at
      // rest. The pointer leaves for the top bar (moving does not close it).
      await page.evaluate(() => document.activeElement && document.activeElement.blur());
      await parkPointer(page);
      await page.waitForTimeout(300);
      const ticks = await page.$$eval('#convo-context-menu .convo-menu-item', (rows) => rows.map((r) => r.textContent.trim()));
      if (ticks.join('|') !== '✓Launch|Hiring|✓Ops') throw new Error(`unexpected Lists menu: ${ticks.join(', ')}`);
    },
  },
];
