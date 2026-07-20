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
  seedWorking, seedLastActive, beginStream, pushChunk,
  ORG_WORKING, ORG_LAST_ACTIVE,
} from './harness.mjs';

export const THEMES = ['light', 'dark'];

// Shot definitions. `hero:true` marks a master that also gets the browser-chrome
// hero treatment in framing. `crop` is an optional element selector for a tight
// feature tile. `target` defaults to the viewport.
export const SHOTS = [
  {
    name: 'org-chart', hero: true, feature: 'Team / org chart',
    crop: '#org-chart',
    async setup(page) {
      await page.evaluate(() => switchNav('team'));
      await page.waitForSelector('.org-card', { timeout: 10000 });
      await seedWorking(page, ORG_WORKING);
      await seedLastActive(page, ORG_LAST_ACTIVE);
      await page.waitForTimeout(200);
    },
  },
  {
    name: 'agent-profile', feature: 'Agent profile',
    async setup(page) {
      await page.evaluate(() => { showProfile('dev'); if (typeof showView === 'function') showView('profile'); });
      await page.waitForSelector('#profile-content', { state: 'visible', timeout: 10000 });
    },
  },
  {
    name: 'skills', feature: 'Skills list and detail',
    crop: '#skill-detail-content',
    async setup(page) {
      await page.evaluate(() => switchNav('skills'));
      await page.waitForSelector('#skills-sidebar-list', { timeout: 10000 });
      await page.evaluate(() => { if (typeof selectSkill === 'function') selectSkill('spec-writer'); });
      await page.waitForTimeout(400);
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
    name: 'streaming', feature: 'Streaming reply',
    async setup(page) {
      await page.evaluate(() => switchNav('conversations'));
      await beginStream(page, { convoId: 'c5', agentId: 'cleo' });
      const chunks = ['Shorter is better here. ', 'Lead with the reader, ',
        'name the outcome in six words, ', 'then let the proof points carry the rest.'];
      for (const c of chunks) { await pushChunk(page, { convoId: 'c5', agentId: 'cleo', text: c }); await page.waitForTimeout(120); }
      await page.waitForSelector('.streaming-text', { timeout: 8000 });
      await page.waitForTimeout(200);
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
      await openFile(page, 'Product Board.md');
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
      await page.evaluate(() => { if (typeof openPalette === 'function') openPalette(); });
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
  {
    name: 'settings', feature: 'Settings / runtimes',
    async setup(page) {
      await page.evaluate(() => switchNav('settings'));
      await page.waitForSelector('#settings-content', { state: 'visible', timeout: 8000 });
      await page.waitForTimeout(400);
    },
  },
];

// Captures every shot in both themes to `stagingDir`. Returns a list of
// produced assets: { name, theme, kind: 'flat'|'crop', feature, hero, file }.
export async function captureStills({ browser, url, stagingDir, log = () => {} }) {
  fs.mkdirSync(stagingDir, { recursive: true });
  const produced = [];

  for (const theme of THEMES) {
    const ctx = await newContext(browser, { motion: false });
    for (const shot of SHOTS) {
      const page = await ctx.newPage();
      try {
        await gotoWorkspace(page, url);
        await setTheme(page, theme);
        await shot.setup(page);
        await settle(page);

        const flat = path.join(stagingDir, `${shot.name}.${theme}.png`);
        await page.screenshot({ path: flat, animations: 'disabled' });
        produced.push({ name: shot.name, theme, kind: 'flat', feature: shot.feature, hero: !!shot.hero, file: flat });
        log(`  captured ${shot.name}.${theme} (flat)`);

        if (shot.crop) {
          const el = await page.$(shot.crop);
          if (el) {
            const box = await el.boundingBox();
            if (box && box.width > 8 && box.height > 8) {
              const crop = path.join(stagingDir, `${shot.name}-tile.${theme}.png`);
              await el.screenshot({ path: crop, animations: 'disabled' });
              produced.push({ name: `${shot.name}-tile`, theme, kind: 'crop', feature: shot.feature, hero: false, file: crop });
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
