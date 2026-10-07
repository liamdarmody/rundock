// Capture harness: drives the running Rundock client with Playwright and writes
// flat, un-framed @2x master PNGs (plus element-scoped crops) for the full
// still shot list, in both light and dark themes. Framing and per-target
// derivations happen later in frame.mjs; this file only produces clean masters.
//
// Every shot runs in a fresh page so seeded client state never leaks between
// shots. A shot that fails is logged and skipped rather than failing the run.

import fs from 'node:fs';
import path from 'node:path';
import {
  newContext, gotoWorkspace, setTheme, settle, openFile,
  CAPTURE_THEMES, selectedForCapture,
} from './harness.mjs';
import { REFRESH_SHOTS } from './scenes.mjs';

export const THEMES = CAPTURE_THEMES;

// Shot definitions. `hero:true` marks a master that also gets the browser-chrome
// hero treatment in framing. `crop` is an optional element selector for a tight
// feature tile. `target` defaults to the viewport.
export const SHOTS = [
  {
    name: 'agent-profile', feature: 'Agent profile',
    async setup(page) {
      await page.evaluate(() => { showProfile('dev'); if (typeof showView === 'function') showView('profile'); });
      await page.waitForSelector('#profile-content', { state: 'visible', timeout: 10000 });
      // Expand the instructions so the profile pane carries real content.
      await page.evaluate(() => document.getElementById('agent-instructions')?.classList.remove('hidden'));
      await page.waitForTimeout(250);
    },
  },
  {
    name: 'skills', feature: 'Skills list and detail',
    crop: '#skill-detail-content',
    async setup(page) {
      await page.evaluate(() => switchNav('skills'));
      await page.waitForSelector('#skills-sidebar-list', { timeout: 10000 });
      // Pick a skill shared by two agents (Dev + Cody) and expand its
      // instructions, so the detail pane is inhabited rather than empty.
      await page.evaluate(() => { if (typeof selectSkill === 'function') selectSkill('code-reviewer'); });
      await page.waitForTimeout(300);
      await page.evaluate(() => document.getElementById('skill-instructions-code-reviewer')?.classList.remove('hidden'));
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'conversations', hero: true, feature: 'Conversation list and open thread',
    crop: '#convo-list',
    async setup(page) {
      await page.evaluate(() => switchNav('conversations'));
      await page.waitForSelector('#convo-list', { timeout: 10000 });
      await page.evaluate(() => { if (typeof openConversation === 'function') openConversation('c1'); });
      await page.waitForSelector('#messages .msg', { timeout: 10000 });
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'files', hero: true, feature: 'File tree with per-type icons',
    crop: '#file-tree',
    async setup(page) {
      await openFile(page, 'Welcome.md');
      await page.waitForSelector('#file-tree', { timeout: 10000 });
      await page.waitForTimeout(300);
    },
  },
  {
    name: 'markdown-note', feature: 'Markdown note: frontmatter, callouts, wikilinks',
    async setup(page) {
      await openFile(page, 'Welcome.md');
      await page.waitForSelector('#tiptap-properties', { timeout: 10000 });
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'callouts', feature: 'Obsidian callouts (nested)',
    async setup(page) {
      await openFile(page, 'Briefing.md');
      await page.waitForSelector('.callout', { timeout: 10000 });
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'kanban-board', feature: 'Kanban board',
    crop: '.board-card',
    async setup(page) {
      await openFile(page, 'Backlog.md');
      await page.waitForSelector('.board-lane', { timeout: 10000 });
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'artifact-review', feature: 'HTML artifact preview and review',
    crop: '.review-sidebar',
    async setup(page) {
      await openFile(page, 'Artifacts/Launch Page.html');
      // Give the artifact iframe + sidecar review a moment to mount and anchor.
      await page.waitForTimeout(1400);
      // Try to expand the review panel if it starts minimised as a pill.
      await page.evaluate(() => {
        const pill = document.querySelector('.review-pill, .review-pill-btn, [data-review-pill]');
        if (pill) pill.click();
      }).catch(() => {});
      await page.waitForTimeout(500);
    },
  },
  {
    name: 'image-viewer', feature: 'Image viewer',
    async setup(page) {
      await openFile(page, 'Assets/Cover.png');
      await page.waitForSelector('.viewer-image-wrap img', { timeout: 10000 });
      await page.waitForTimeout(400);
    },
  },
  {
    name: 'pdf-viewer', feature: 'PDF viewer',
    async setup(page) {
      await openFile(page, 'Assets/Spec.pdf');
      await page.waitForSelector('iframe.viewer-frame', { timeout: 10000 });
      await page.waitForTimeout(900);
    },
  },
  {
    name: 'search', feature: 'Universal search (Cmd+K)',
    crop: '.palette',
    async setup(page) {
      await page.evaluate(() => switchNav('team'));
      await page.waitForTimeout(200);
      // Click the search control in the top bar rather than calling the
      // function behind it. Search expands in place from that control, so
      // driving it any other way photographs a state the product does not
      // actually produce.
      await page.click('#tb-search');
      await page.waitForSelector('#palette-input', { state: 'visible', timeout: 8000 });
      await page.fill('#palette-input', 'launch');
      await page.waitForTimeout(600);
    },
  },
  {
    name: 'find', feature: 'In-view find (Cmd+F)',
    async setup(page) {
      await openFile(page, 'Welcome.md');
      await page.waitForSelector('#tiptap-properties', { timeout: 10000 });
      await page.evaluate(() => { if (typeof openFindBar === 'function') openFindBar(); });
      await page.waitForSelector('#find-bar', { state: 'visible', timeout: 8000 });
      await page.fill('#find-input', 'workspace');
      await page.waitForTimeout(500);
    },
  },
  // The team chart and the routines list are scenes in scenes.mjs
  // (IMG-01, IMG-13), which replaced the shots that were here.
  ...REFRESH_SHOTS,
];

// The shots a run captures: all of them, or those RUNDOCK_CAPTURE_ONLY names.
export function selectedShots() {
  return SHOTS.filter(selectedForCapture);
}

// The workspace variants the selected shots need, so a run boots only the
// servers it uses.
export function variantsNeeded(shots = selectedShots()) {
  return [...new Set(shots.map((s) => s.variant || 'main'))];
}

// Captures every selected shot in every capture theme to `stagingDir`.
// `urls` maps a workspace variant to its server. Returns a list of produced
// assets: { name, id, theme, kind: 'flat'|'crop', feature, hero, file }.
export async function captureStills({ browser, urls, stagingDir, log = () => {} }) {
  fs.mkdirSync(stagingDir, { recursive: true });
  const produced = [];
  const shots = selectedShots();

  for (const theme of THEMES) {
    const ctx = await newContext(browser, { motion: false, theme });
    for (const shot of shots) {
      const page = await ctx.newPage();
      const base = urls[shot.variant || 'main'];
      const record = (kind, name, file) => produced.push({ name, id: shot.id || null, theme, kind, feature: shot.feature, hero: kind === 'flat' && !!shot.hero, file });
      try {
        if (!base) throw new Error(`no server for workspace variant "${shot.variant}"`);
        if (shot.page) {
          // A page of its own (the component gallery), not the workspace.
          await page.goto(base + shot.page, { waitUntil: 'domcontentloaded' });
        } else {
          await gotoWorkspace(page, base);
          await setTheme(page, theme);
        }
        await shot.setup(page);
        await settle(page);

        const flat = path.join(stagingDir, `${shot.name}.${theme}.png`);
        await page.screenshot({ path: flat, animations: 'disabled' });
        record('flat', shot.name, flat);
        log(`  captured ${shot.name}.${theme} (flat)`);

        const crop = path.join(stagingDir, `${shot.name}-tile.${theme}.png`);
        if (shot.tile) {
          if (await shot.tile(page, crop)) { record('crop', `${shot.name}-tile`, crop); log(`  captured ${shot.name}-tile.${theme} (tile)`); }
          else log(`  ! tile for ${shot.name} found nothing to capture, skipped`);
        } else if (shot.crop) {
          const el = await page.$(shot.crop);
          if (el) {
            const box = await el.boundingBox();
            if (box && box.width > 8 && box.height > 8) {
              await el.screenshot({ path: crop, animations: 'disabled' });
              record('crop', `${shot.name}-tile`, crop);
              log(`  captured ${shot.name}-tile.${theme} (crop)`);
            } else { log(`  ! crop ${shot.name} has no usable box, skipped`); }
          } else { log(`  ! crop selector ${shot.crop} not found for ${shot.name}, skipped`); }
        }
      } catch (err) {
        log(`  ! shot ${shot.name}.${theme} failed: ${err.message.split('\n')[0]}`);
      } finally {
        await page.close();
      }
    }
    await ctx.close();
  }
  return produced;
}
