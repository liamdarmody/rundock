// Motion layer: records the six scripted interactions with Playwright video,
// then converts each to a web-optimized, palette-optimized, infinitely looping
// GIF with ffmpeg (palettegen/paletteuse). Clips are short (roughly 4-6s),
// silent, and loopable.
//
// ffmpeg is resolved in priority order: FFMPEG_PATH env, a system ffmpeg on
// PATH, then the ffmpeg-static dev dependency. The first that works wins, so CI
// can use a system binary while a local run falls back to ffmpeg-static.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import {
  newContext, gotoWorkspace, setTheme, openFile, beginStream, pushChunk,
  seedWorking, seedLastActive, ORG_WORKING, ORG_LAST_ACTIVE,
} from './harness.mjs';

const require = createRequire(import.meta.url);

// --- ffmpeg resolution -----------------------------------------------------
let _ffmpeg;
export function resolveFfmpeg() {
  if (_ffmpeg) return _ffmpeg;
  const candidates = [];
  if (process.env.FFMPEG_PATH) candidates.push(process.env.FFMPEG_PATH);
  candidates.push('ffmpeg'); // system PATH
  try { candidates.push(require('ffmpeg-static')); } catch { /* not installed */ }
  for (const c of candidates) {
    if (!c) continue;
    try { execFileSync(c, ['-version'], { stdio: 'ignore' }); _ffmpeg = c; return c; }
    catch { /* try next */ }
  }
  throw new Error('No usable ffmpeg found (set FFMPEG_PATH, install ffmpeg, or `npm install`).');
}

export function ffmpegAvailable() {
  try { resolveFfmpeg(); return true; } catch { return false; }
}

// Two-pass palette conversion: webm -> optimized looping GIF.
export function gifFromWebm(webmPath, gifPath, { fps = 15, width = 1280 } = {}) {
  const ffmpeg = resolveFfmpeg();
  const palette = path.join(os.tmpdir(), `pal-${path.basename(gifPath, '.gif')}-${width}.png`);
  const filters = `fps=${fps},scale=${width}:-1:flags=lanczos`;
  execFileSync(ffmpeg, ['-y', '-i', webmPath, '-vf', `${filters},palettegen=stats_mode=diff`, palette], { stdio: 'ignore' });
  execFileSync(ffmpeg, ['-y', '-i', webmPath, '-i', palette,
    '-lavfi', `${filters} [x]; [x][1:v] paletteuse=dither=bayer:bayer_scale=3`,
    '-loop', '0', gifPath], { stdio: 'ignore' });
  try { fs.unlinkSync(palette); } catch { /* ignore */ }
  return gifPath;
}

// --- Clip scripts ----------------------------------------------------------
// Each clip drives one scripted interaction. Kept short and loopable.

async function clipKanbanDrag(page) {
  await openFile(page, 'Product Board.md');
  await page.waitForSelector('.board-card', { timeout: 10000 });
  await page.waitForTimeout(700);
  // Animate a lifted clone gliding from the first Backlog card to the In
  // Progress lane, then dispatch the real HTML5 drag-and-drop so the board
  // model actually moves the card and re-renders it in the target lane.
  await page.evaluate(() => {
    const card = document.querySelector('.board-lane .board-card');
    const lanes = document.querySelectorAll('.board-lane-body');
    const target = lanes[1] || lanes[0];
    const cr = card.getBoundingClientRect();
    const tr = target.getBoundingClientRect();
    const clone = card.cloneNode(true);
    Object.assign(clone.style, {
      position: 'fixed', left: cr.left + 'px', top: cr.top + 'px', width: cr.width + 'px',
      margin: '0', zIndex: '9999', pointerEvents: 'none', transition: 'transform 0.9s cubic-bezier(.2,.7,.3,1)',
      boxShadow: '0 18px 40px rgba(0,0,0,0.28)', transform: 'scale(1.03)',
    });
    document.body.appendChild(clone);
    card.style.opacity = '0.35';
    const dx = (tr.left + 24) - cr.left;
    const dy = (tr.top + 16) - cr.top;
    requestAnimationFrame(() => { clone.style.transform = `translate(${dx}px, ${dy}px) scale(1.03)`; });
    window.__dragClone = clone; window.__dragCard = card; window.__dragTarget = target;
  });
  await page.waitForTimeout(1050);
  await page.evaluate(() => {
    const card = window.__dragCard, target = window.__dragTarget;
    const dt = new DataTransfer();
    const fire = (el, type, cx, cy) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt, clientX: cx, clientY: cy }));
    const cr = card.getBoundingClientRect(), tr = target.getBoundingClientRect();
    fire(card, 'dragstart', cr.left + cr.width / 2, cr.top + cr.height / 2);
    fire(target, 'dragenter', tr.left + tr.width / 2, tr.top + 20);
    fire(target, 'dragover', tr.left + tr.width / 2, tr.top + 20);
    fire(target, 'drop', tr.left + tr.width / 2, tr.top + 20);
    fire(card, 'dragend', tr.left + tr.width / 2, tr.top + 20);
    if (window.__dragClone) window.__dragClone.remove();
  });
  await page.waitForTimeout(1100);
}

async function clipLiveRefresh(page, { workspace }) {
  await openFile(page, 'Roadmap.md');
  await page.waitForTimeout(1400);
  // Change the file on disk, as an agent or another window would. The open
  // file updates in place.
  const target = path.join(workspace, 'Roadmap.md');
  const updated = ['---', 'title: Roadmap', 'tags: [planning]', 'updated: 2026-07-18', '---', '',
    '# Roadmap', '', '1. Ship the launch page', '2. Tidy the onboarding flow', '3. Gather early feedback',
    '4. Line up the follow-up release', ''].join('\n');
  fs.writeFileSync(target, updated);
  await page.waitForTimeout(2200);
}

async function clipArtifactComment(page) {
  await openFile(page, 'Artifacts/Launch Page.html');
  await page.waitForTimeout(1600);
  // Select a phrase inside the sandboxed preview iframe and raise the Comment
  // affordance, exactly as a user selecting text would.
  await page.evaluate(() => {
    const frame = document.querySelector('iframe.viewer-frame');
    if (!frame) return;
    const doc = frame.contentDocument;
    const el = [...doc.querySelectorAll('p, h1, .stat')].find((n) => /faster reviews/i.test(n.textContent));
    if (!el) return;
    const range = doc.createRange();
    range.selectNodeContents(el);
    const sel = frame.contentWindow.getSelection();
    sel.removeAllRanges(); sel.addRange(range);
    doc.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.waitForTimeout(900);
  // Click the Comment button if it surfaced.
  const btn = await page.$('.artifact-comment-btn.visible, .artifact-comment-btn');
  if (btn) { await btn.click().catch(() => {}); await page.waitForTimeout(700); }
  // Type into the comment composer if it opened.
  const composer = await page.$('.review-comment-input, textarea.review-input, .review-sidebar textarea');
  if (composer) { await composer.type('Worth adding a source note here.', { delay: 35 }); await page.waitForTimeout(700); }
  await page.waitForTimeout(700);
}

async function clipSearch(page) {
  await page.evaluate(() => switchNav('team'));
  await page.waitForTimeout(500);
  await page.evaluate(() => { if (typeof openPalette === 'function') openPalette(); });
  await page.waitForSelector('#palette-input', { state: 'visible', timeout: 8000 });
  await page.waitForTimeout(500);
  await page.type('#palette-input', 'launch', { delay: 160 });
  await page.waitForTimeout(1600);
}

async function clipStreaming(page) {
  await page.evaluate(() => switchNav('conversations'));
  await beginStream(page, { convoId: 'c5', agentId: 'cleo' });
  const chunks = ['Shorter is better here. ', 'Lead with the reader, ', 'name the outcome in six words, ',
    'then let the proof points carry the rest. ', 'I will draft two options and mark my pick.'];
  for (const c of chunks) { await pushChunk(page, { convoId: 'c5', agentId: 'cleo', text: c }); await page.waitForTimeout(700); }
  await page.waitForTimeout(1000);
}

async function clipOrgStatus(page) {
  await page.evaluate(() => switchNav('team'));
  await page.waitForSelector('.org-card', { timeout: 10000 });
  await seedWorking(page, ORG_WORKING);
  await seedLastActive(page, ORG_LAST_ACTIVE);
  // Let the CSS pulse (orgPulse, 2s loop) run for a couple of cycles.
  await page.waitForTimeout(4200);
}

// Clip registry. `themes` is which themes to record (theme reads in all of
// these, but the spec only mandates parity for the org-status clip; the others
// default to both for completeness).
// `gif` overrides the default {fps:15, width:1280} for clips that would
// otherwise crowd the file-size budget (the review clip has a lot of motion:
// a selection highlight plus type-in).
export const CLIPS = [
  { name: 'kanban-drag', feature: 'Kanban card drag between columns', run: clipKanbanDrag },
  { name: 'live-refresh', feature: 'Live external refresh updating the open file', run: clipLiveRefresh },
  { name: 'review-comment', feature: 'Adding a comment on an artifact', run: clipArtifactComment, gif: { width: 1152 } },
  { name: 'search', feature: 'Cmd+K universal search', run: clipSearch },
  { name: 'streaming', feature: 'Streaming reply typing in', run: clipStreaming },
  { name: 'org-chart-status', feature: 'Org chart live status', run: clipOrgStatus },
];

export const MOTION_THEMES = ['light', 'dark'];

// Records every clip in both themes and converts each to an optimized GIF in
// `outDir`. Returns produced assets: { name, theme, feature, file, bytes }.
export async function captureMotion({ browser, url, workspace, outDir, log = () => {} }) {
  fs.mkdirSync(outDir, { recursive: true });
  const videoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rundock-motion-'));
  const produced = [];

  for (const clip of CLIPS) {
    for (const theme of MOTION_THEMES) {
      let ctx;
      try {
        ctx = await newContext(browser, { motion: true, recordVideoDir: videoDir });
        const page = await ctx.newPage();
        await gotoWorkspace(page, url);
        await setTheme(page, theme);
        await clip.run(page, { workspace });
        const video = page.video();
        await page.close();
        const webm = await video.path();
        await ctx.close(); ctx = null;

        const gif = path.join(outDir, `${clip.name}.${theme}.gif`);
        gifFromWebm(webm, gif, { fps: clip.gif?.fps ?? 15, width: clip.gif?.width ?? 1280 });
        const bytes = fs.statSync(gif).size;
        produced.push({ name: clip.name, theme, feature: clip.feature, file: gif, bytes });
        log(`  motion ${clip.name}.${theme} -> ${(bytes / 1e6).toFixed(2)} MB`);
      } catch (err) {
        log(`  ! clip ${clip.name}.${theme} failed: ${err.message.split('\n')[0]}`);
        if (ctx) { try { await ctx.close(); } catch { /* ignore */ } }
      }
    }
  }
  try { fs.rmSync(videoDir, { recursive: true, force: true }); } catch { /* ignore */ }
  return produced;
}
